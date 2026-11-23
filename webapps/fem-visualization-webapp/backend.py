"""Dataiku Standard WebApp -- Python backend (Flask).

Copy this file into the WebApp's Python editor. Set the two folder IDs below.
The BDF folder contains the main BDF and any referenced INCLUDE files.
The displacement folder contains CSVs produced by the generic OP2 exporter.

Dependencies in the WebApp backend code environment: pyNastran, pandas, numpy.
Flask and dataiku are supplied by the DSS standard Python-backed WebApp.
"""

# ======================= USER CONFIGURATION =======================
BDF_FOLDER_ID = "A5atNsl0"
DISPLACEMENTS_FOLDER_ID = "MqU5B90T"

# False for the raw pyNastran displacements__case_*.csv produced earlier.
# Set True ONLY if you have already transformed CSV translations to basic XYZ.
CSV_TRANSLATIONS_ALREADY_BASIC = True

# Render thresholds (raise for more powerful DSS WebApp servers/browsers).
MAX_RENDER_NODES = 150_000
MAX_RENDER_TRIANGLES = 250_000
MAX_RENDER_EDGES = 70_000

# Files in the BDF folder with these extensions may be staged as INCLUDEs.
# Files without an extension are also allowed.
BDF_EXTENSIONS = {".bdf", ".nas", ".dat", ".inc", ".fem", ".blk", ".txt", ""}
# ================================================================

import io
import os
import shutil
import tempfile
from collections import Counter
from pathlib import Path, PurePosixPath

import dataiku
import numpy as np
import pandas as pd
from flask import jsonify, request
from pyNastran.bdf.bdf import read_bdf

# A Standard Dataiku WebApp with Flask provides the `app` Flask object.
# Do not create a second Flask app here.


def _folder(folder_id):
    if not folder_id or folder_id.startswith("REPLACE_WITH_"):
        raise ValueError("Configure BDF_FOLDER_ID and DISPLACEMENTS_FOLDER_ID in backend.py")
    return dataiku.Folder(folder_id)


def _paths(folder):
    return sorted({str(x).lstrip("/") for x in folder.list_paths_in_partition()
                   if str(x).strip("/")})


def _safe_path(path):
    """Constrain requests to safe paths inside the selected managed folder."""
    path = str(path).lstrip("/")
    p = PurePosixPath(path)
    if not path or any(part in ("", "..", ".") for part in p.parts) or "\\" in path:
        raise ValueError("Invalid managed-folder file path")
    return path


def _available_bdfs(folder):
    return [p for p in _paths(folder) if PurePosixPath(p).suffix.lower() in {".bdf", ".nas", ".dat", ".fem"}]


def _available_csvs(folder):
    return [p for p in _paths(folder)
            if p.lower().endswith(".csv") and "displacement" in PurePosixPath(p).name.lower()]


def _validate_selected(folder, filename, allowed_paths):
    filename = _safe_path(filename)
    if filename not in allowed_paths:
        raise ValueError("Selected file is not available in the configured managed folder: " + filename)
    return filename


def _read_displacements(folder, csv_path):
    csv_path = _validate_selected(folder, csv_path, _available_csvs(folder))
    with folder.get_download_stream(csv_path) as stream:
        df = pd.read_csv(stream, low_memory=False)
    # The generic extractor produces node_id, t1, t2, t3.
    lower_names = {str(c).lower(): str(c) for c in df.columns}
    required = ("node_id", "t1", "t2", "t3")
    absent = [c for c in required if c not in lower_names]
    if absent:
        if any(c in lower_names for c in ("t1_real", "t1_imag")):
            raise ValueError("Complex displacement CSV detected. This WebApp supports real-valued results only; extract a selected phase before plotting.")
        raise ValueError("Missing required displacement columns: " + ", ".join(absent) + ". Found: " + ", ".join(map(str, df.columns)))
    df = df.rename(columns={lower_names[c]: c for c in required})
    return df


def _unique_steps(df):
    """Return distinct subcase/step selections for the file."""
    working = df.copy()
    if "subcase" not in working.columns:
        working["subcase"] = ""
    if "step_index" not in working.columns:
        working["step_index"] = 0
    if "step_value" not in working.columns:
        working["step_value"] = ""
    records = []
    for (subcase, index, value), _ in working.groupby(
            ["subcase", "step_index", "step_value"], dropna=False, sort=False):
        s = "" if pd.isna(subcase) else str(subcase)
        ix = "0" if pd.isna(index) else str(index)
        val = "" if pd.isna(value) else str(value)
        records.append({
            "subcase": s, "step_index": ix, "step_value": val,
            "label": f"Subcase {s or 'n/a'} · Step {ix}" + (f" · Value {val}" if val else "")
        })
    return records


def _filter_step(df, selection):
    options = _unique_steps(df)
    if not options:
        raise ValueError("Selected displacement CSV is empty")
    if selection is None:
        if len(options) > 1:
            raise ValueError("Choose a displacement step before visualizing")
        selection = options[0]
    if not isinstance(selection, dict):
        raise ValueError("Invalid step selection")
    keys = ("subcase", "step_index", "step_value")
    if not any(all(str(entry[k]) == str(selection.get(k, "")) for k in keys)
               for entry in options):
        raise ValueError("Step selection is not present in this displacement CSV")
    mask = pd.Series(True, index=df.index)
    for col in keys:
        if col in df.columns:
            mask &= df[col].fillna("").astype(str).eq(str(selection.get(col, "")))
    return df.loc[mask].copy()


def _materialize_bdf(folder, bdf_filename, temporary_root):
    """Stage BDF and sibling INCLUDEs, keeping folder-relative hierarchy."""
    all_paths = _paths(folder)
    bdf_filename = _validate_selected(folder, bdf_filename, _available_bdfs(folder))
    candidates = [p for p in all_paths if PurePosixPath(p).suffix.lower() in BDF_EXTENSIONS]
    if len(candidates) > 500:
        raise ValueError("BDF folder contains more than 500 geometry/include files; reduce it or adjust the limit")
    for p in candidates:
        p = _safe_path(p)
        destination = Path(temporary_root).joinpath(*PurePosixPath(p).parts)
        destination.parent.mkdir(parents=True, exist_ok=True)
        with folder.get_download_stream(p) as stream, open(destination, "wb") as dst:
            shutil.copyfileobj(stream, dst, length=1024 * 1024)
    return Path(temporary_root).joinpath(*PurePosixPath(bdf_filename).parts)


# Element corner-node layouts. Higher-order midside nodes are not tessellated.
SOLID_FACE_INDICES = {
    "CTETRA": [(0, 1, 2), (0, 3, 1), (1, 3, 2), (2, 3, 0)],
    "CPENTA": [(0, 2, 1), (3, 4, 5), (0, 1, 4, 3), (1, 2, 5, 4), (2, 0, 3, 5)],
    "CHEXA": [(0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)],
    "CPYRAM": [(0, 3, 2, 1), (0, 1, 4), (1, 2, 4), (2, 3, 4), (3, 0, 4)],
}
LINE_ELEMENTS = {"CBAR", "CBEAM", "CROD", "CONROD", "CTUBE", "CBUSH"}


def _surface_and_beams(model):
    shells = []
    solids = []
    beams = []
    unsupported = Counter()
    stats = Counter()
    for _eid, elem in model.elements.items():
        kind = str(elem.type).upper()
        try:
            ids = list(elem.node_ids)
        except (AttributeError, TypeError):
            unsupported[kind] += 1
            continue
        if kind.startswith("CTRIA") and len(ids) >= 3:
            face = ids[:3]
            if all(x is not None for x in face):
                shells.append(tuple(map(int, face)))
                stats["shell_elements"] += 1
                if len(ids) > 3:
                    stats["linearized_elements"] += 1
            else:
                unsupported[kind] += 1
        elif kind.startswith("CQUAD") and len(ids) >= 4:
            face = ids[:4]
            if all(x is not None for x in face):
                shells.append(tuple(map(int, face)))
                stats["shell_elements"] += 1
                if len(ids) > 4:
                    stats["linearized_elements"] += 1
            else:
                unsupported[kind] += 1
        elif kind in SOLID_FACE_INDICES:
            corners = ids[:max(max(face) for face in SOLID_FACE_INDICES[kind]) + 1]
            if all(x is not None for x in corners):
                stats["solid_elements"] += 1
                for spec in SOLID_FACE_INDICES[kind]:
                    solids.append(tuple(int(corners[i]) for i in spec))
            else:
                unsupported[kind] += 1
        elif kind in LINE_ELEMENTS and len(ids) >= 2 and all(x is not None for x in ids[:2]):
            beams.append(tuple(map(int, ids[:2])))
            stats["line_elements"] += 1
        else:
            unsupported[kind] += 1

    # Keep only external faces of solids, not internal shared faces.
    face_counts = Counter(tuple(sorted(face)) for face in solids)
    exposed_solids = [face for face in solids if face_counts[tuple(sorted(face))] == 1]
    stats["external_solid_faces"] = len(exposed_solids)
    stats["ignored_elements"] = sum(unsupported.values())
    return shells + exposed_solids, beams, stats, unsupported


def _mesh_payload(model, df):
    faces, beam_segments, stats, unsupported = _surface_and_beams(model)
    visible = {nid for f in faces for nid in f} | {nid for line in beam_segments for nid in line}
    visible.intersection_update(model.nodes.keys())
    if not visible:
        raise ValueError("No supported shell/solid/beam geometry to display. Supported types: CTRIA*, CQUAD*, CTETRA, CHEXA, CPENTA, CPYRAM, CBAR, CBEAM, CROD, CONROD, CTUBE, CBUSH.")
    if len(visible) > MAX_RENDER_NODES:
        raise ValueError(f"Mesh has {len(visible):,} visible nodes, over configured limit {MAX_RENDER_NODES:,}")

    df = df.copy()
    df["node_id"] = pd.to_numeric(df["node_id"], errors="coerce")
    df = df.loc[df["node_id"].notna()]
    df["node_id"] = df["node_id"].astype("int64")
    if df["node_id"].duplicated().any():
        raise ValueError("Selected CSV step contains duplicate node IDs. Filter to one result step first.")
    for col in ("t1", "t2", "t3"):
        df[col] = pd.to_numeric(df[col], errors="coerce")
    bad = ~np.isfinite(df[["t1", "t2", "t3"]].to_numpy(dtype=float)).all(axis=1)
    invalid_values = int(bad.sum())
    df = df.loc[~bad]
    displacement_map = {int(nid): np.asarray([x, y, z], dtype=float)
                        for nid, x, y, z in df[["node_id", "t1", "t2", "t3"]].itertuples(index=False, name=None)}

    node_ids = sorted(visible)
    index = {nid: i for i, nid in enumerate(node_ids)}
    coords = []
    vectors = []
    missing = 0
    converted = 0
    for nid in node_ids:
        node = model.nodes[nid]
        xyz = np.asarray(node.get_position(), dtype=float)
        if not np.isfinite(xyz).all():
            raise ValueError(f"Non-finite position for BDF GRID {nid}")
        vec = displacement_map.get(nid)
        if vec is None:
            vec = np.zeros(3, dtype=float)
            missing += 1
        else:
            cd = int(node.Cd())
            if cd != 0 and not CSV_TRANSLATIONS_ALREADY_BASIC:
                coord = model.coords[cd]
                if str(coord.type).upper() not in {"CORD1R", "CORD2R"}:
                    raise ValueError(
                        f"GRID {nid} uses CD={cd} ({coord.type}). "
                        "Raw cylindrical/spherical displacement components need a position-dependent "
                        "transformation to basic coordinates; this WebApp intentionally does not guess. "
                        "Pre-transform displacements using pyNastran and set "
                        "CSV_TRANSLATIONS_ALREADY_BASIC=True."
                    )
                # pyNastran beta rotates local rectangular vector (row) to basic XYZ.
                vec = vec @ np.asarray(coord.beta(), dtype=float)
                converted += 1
        coords.append(xyz.tolist())
        vectors.append(np.asarray(vec, dtype=float).tolist())

    triangles = []
    edges = set()
    for face in faces:
        if any(nid not in index for nid in face):
            continue
        verts = [index[nid] for nid in face]
        for k in range(1, len(verts) - 1):
            triangles.append([verts[0], verts[k], verts[k + 1]])
        for a, b in zip(verts, verts[1:] + verts[:1]):
            edges.add(tuple(sorted((a, b))))
    for a, b in beam_segments:
        if a in index and b in index:
            edges.add(tuple(sorted((index[a], index[b]))))
    if len(triangles) > MAX_RENDER_TRIANGLES:
        raise ValueError(f"Mesh has {len(triangles):,} rendered triangles, over {MAX_RENDER_TRIANGLES:,} limit")
    all_edges = sorted(edges)
    edge_trimmed = max(0, len(all_edges) - MAX_RENDER_EDGES)
    all_edges = all_edges[:MAX_RENDER_EDGES]

    warnings = []
    if missing:
        warnings.append(f"{missing:,} of {len(node_ids):,} displayed nodes have no displacement row; zero displacement was assumed for display ONLY.")
    if invalid_values:
        warnings.append(f"{invalid_values:,} non-numeric/non-finite displacement rows were ignored.")
    if unsupported:
        summary = ", ".join(f"{kind} ({n})" for kind, n in unsupported.most_common(8))
        warnings.append(f"Some element types were omitted: {summary}.")
    if edge_trimmed:
        warnings.append(f"Wireframe edges limited to {MAX_RENDER_EDGES:,}; {edge_trimmed:,} additional edges are hidden.")
    if not triangles:
        warnings.append("No polygon faces were found; displaying beam/rod elements as lines only.")
    if converted:
        warnings.append(f"Transformed {converted:,} rectangular-CD displacement vectors to basic XYZ.")
    if stats["linearized_elements"]:
        warnings.append(f"{stats['linearized_elements']:,} higher-order shell elements were rendered using only corner nodes; midside curvature is not represented.")

    return {
        "node_ids": node_ids,
        "xyz": coords,
        "translations": vectors,
        "triangles": triangles,
        "edges": all_edges,
        "metadata": {
            "bdf_nodes_total": len(model.nodes),
            "bdf_elements_total": len(model.elements),
            "displayed_nodes": len(node_ids),
            "matched_displacement_nodes": len(node_ids) - missing,
            "missing_displacement_nodes": missing,
            "extra_result_nodes": len(set(displacement_map) - set(model.nodes)),
            "rendered_triangles": len(triangles),
            "rendered_edges": len(all_edges),
            "shell_elements": stats["shell_elements"],
            "solid_elements": stats["solid_elements"],
            "line_elements": stats["line_elements"],
            "external_solid_faces": stats["external_solid_faces"],
            "unsupported_elements": stats["ignored_elements"],
            "warnings": warnings,
            "coordinate_system": "basic XYZ",
        },
    }


def _error_response(exc, code=400):
    # Details help diagnose missing INCLUDEs and wrong CSV schemas in DSS.
    return jsonify({"error": str(exc), "error_type": type(exc).__name__}), code


@app.route("/api/files", methods=["GET"])
def available_mesh_files():
    try:
        bdf = _folder(BDF_FOLDER_ID)
        displacements = _folder(DISPLACEMENTS_FOLDER_ID)
        return jsonify({"bdf_files": _available_bdfs(bdf),
                        "displacement_files": _available_csvs(displacements)})
    except Exception as exc:
        return _error_response(exc)


@app.route("/api/steps", methods=["GET"])
def available_displacement_steps():
    try:
        csv_path = request.args.get("csv", "")
        df = _read_displacements(_folder(DISPLACEMENTS_FOLDER_ID), csv_path)
        return jsonify({"steps": _unique_steps(df), "rows": len(df)})
    except Exception as exc:
        return _error_response(exc)


@app.route("/api/mesh", methods=["POST"])
def mesh_and_displacements():
    try:
        body = request.get_json(silent=True) or {}
        bdf_name = body.get("bdf", "")
        csv_name = body.get("displacements", "")
        selection = body.get("step")
        bdf_folder = _folder(BDF_FOLDER_ID)
        df = _read_displacements(_folder(DISPLACEMENTS_FOLDER_ID), csv_name)
        df = _filter_step(df, selection)
        with tempfile.TemporaryDirectory(prefix="dataiku_fea_webapp_") as work:
            bdf_filename = _materialize_bdf(bdf_folder, bdf_name, work)
            model = read_bdf(str(bdf_filename), xref=True, validate=False, debug=False)
            output = _mesh_payload(model, df)
        output["files"] = {"bdf": bdf_name, "displacements": csv_name,
                           "step": selection or _unique_steps(df)[0]}
        return jsonify(output)
    except Exception as exc:
        return _error_response(exc)
