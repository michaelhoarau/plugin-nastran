/* Dataiku Standard WebApp: JavaScript editor.
 * Uses Plotly from <script> tag in body.html, Dataiku Flask backend endpoints.
 */
(() => {
  "use strict";
  let mesh = null;
  let loadGeneration = 0;
  let stepGeneration = 0;
  let stressGeneration = 0;
  const $ = (id) => document.getElementById(id);
  const fmt = (n) => Number(n).toLocaleString(undefined, {maximumFractionDigits: 5});

  function status(message, style="") {
    $("fea-status").textContent = message;
    $("fea-status").className = "fea-status " + style;
  }
  function showError(message) {
    const el = $("fea-message");
    el.hidden = false;
    el.textContent = message;
    status("Error", "bad");
  }
  function clearError() {
    $("fea-message").hidden = true;
    $("fea-message").textContent = "";
  }
  function invalidate() {
    ++loadGeneration;
    if (mesh) {
      mesh = null;
      if (typeof Plotly !== "undefined") Plotly.purge("fea-chart");
      $("fea-chart").innerHTML = '<div class="fea-placeholder"><strong>Selection changed</strong><p>Click Visualize mesh to load the selected result.</p></div>';
    }
    status("Click Visualize mesh");
  }
  async function api(path, options={}) {
    if (typeof getWebAppBackendUrl !== "function") {
      throw new Error("getWebAppBackendUrl() unavailable. Enable a Python (Flask) backend on a Dataiku Standard WebApp.");
    }
    const response = await fetch(getWebAppBackendUrl(path), options);
    let data;
    try { data = await response.json(); }
    catch (_) { throw new Error("Non-JSON backend response (HTTP " + response.status + "). Check the backend logs."); }
    if (!response.ok || data.error) throw new Error(data.error || "Backend HTTP " + response.status);
    return data;
  }
  function populateSelect(el, paths, emptyLabel, allowNone=false) {
    el.replaceChildren();
    if (allowNone) {
      const opt=document.createElement("option");
      opt.value="";
      opt.textContent="None (geometry only / stress-only)";
      el.append(opt);
    }
    if (!paths.length && !allowNone) {
      const opt=document.createElement("option"); opt.value=""; opt.textContent=emptyLabel; el.append(opt);
    }
    for (const entry of paths) {
      const opt=document.createElement("option");
      opt.value=entry;
      opt.textContent=entry;
      el.append(opt);
    }
  }
  function populateObjects(el, items) {
    el.replaceChildren();
    for (const entry of items) {
      const opt=document.createElement("option");
      opt.value=entry.value;
      opt.textContent=entry.label;
      el.append(opt);
    }
  }
  function populateSteps(el, steps) {
    el.replaceChildren();
    if (!steps.length) { populateSelect(el, [], "No result steps found"); return; }
    for (const step of steps) {
      const opt=document.createElement("option");
      opt.value=JSON.stringify(step);
      opt.textContent=step.label;
      el.append(opt);
    }
  }
  async function fetchCatalog() {
    status("Reading folders…", "working");
    clearError(); invalidate();
    try {
      const result = await api("/api/files");
      populateSelect($("fea-bdf"), result.bdf_files || [], "No BDF files found");
      populateSelect($("fea-csv"), result.displacement_files || [], "No displacement CSVs found", true);
      if ((result.displacement_files || []).length) $("fea-csv").value = result.displacement_files[0];
      populateSelect($("fea-stress-csv"), result.stress_files || [], "No stress CSVs found", true);
      await Promise.all([fetchSteps(), fetchStressOptions()]);
      status("Ready");
    } catch (error) { showError(error.message); }
  }
  async function fetchSteps() {
    const generation=++stepGeneration;
    const csv=$("fea-csv").value;
    if (!csv) { populateSelect($("fea-step"), [], "No displacement result selected"); return; }
    try {
      const result=await api("/api/steps?csv=" + encodeURIComponent(csv));
      if (generation !== stepGeneration) return;
      populateSteps($("fea-step"), result.steps || []);
    } catch(error) { if (generation === stepGeneration) showError(error.message); }
  }
  function alignDisplacementsToStressFolder() {
    const stressCsv=$("fea-stress-csv").value;
    if (!stressCsv) return false;
    const folder=stressCsv.includes("/") ? stressCsv.slice(0,stressCsv.lastIndexOf("/")+1) : "";
    const selected=$("fea-csv").value;
    // Match the OP2 result folder, never silently deform with a different model.
    if (selected && selected.startsWith(folder) && selected !== "") return false;
    const options=Array.from($("fea-csv").options).map(o=>o.value);
    const match=options.find(path=>path && path.startsWith(folder) && path.slice(folder.length).startsWith("displacements__case_"));
    $("fea-csv").value=match || "";
    return selected !== $("fea-csv").value;
  }
  function refreshStressVisibility() {
    const mode=$("fea-color").value;
    $("fea-stress-fields").hidden = mode !== "stress";
  }
  async function fetchStressOptions() {
    const generation=++stressGeneration;
    const csv=$("fea-stress-csv").value;
    if (!csv) {
      populateSelect($("fea-stress-step"), [], "Choose a stress CSV");
      populateSelect($("fea-component"), [], "Choose a stress CSV");
      populateSelect($("fea-layer"), [], "Choose a stress CSV");
      return;
    }
    try {
      const result=await api("/api/stress/options?csv=" + encodeURIComponent(csv));
      if (generation !== stressGeneration) return;
      populateSteps($("fea-stress-step"), result.steps || []);
      populateSelect($("fea-component"), result.components || [], "No numeric stress fields");
      populateObjects($("fea-layer"), result.layers || []);
    } catch(error) { if (generation === stressGeneration) showError(error.message); }
  }
  function norm3(v) {return Math.hypot(v[0],v[1],v[2]);}
  function meshScalars() {
    const mode=$("fea-color").value;
    if (mode === "mag") return mesh.translations.map(norm3);
    const component={ux:0,uy:1,uz:2}[mode];
    return mesh.translations.map(vec => vec[component]);
  }
  function scalarLabel() {
    const mode=$("fea-color").value;
    if (mode === "stress") {
      const data=mesh && mesh.stress;
      return data ? data.component + " (" + data.layer + ", " + data.aggregate + ")" : "Stress";
    }
    return {mag:"|U|",ux:"Ux",uy:"Uy",uz:"Uz"}[mode] || "Displacement";
  }
  function pointArrays(points) {
    return {x:points.map(v=>v[0]), y:points.map(v=>v[1]), z:points.map(v=>v[2])};
  }
  function edgeTrace(points, edges, options) {
    const x=[],y=[],z=[];
    for (const [a,b] of edges) {
      x.push(points[a][0],points[b][0],null);
      y.push(points[a][1],points[b][1],null);
      z.push(points[a][2],points[b][2],null);
    }
    return {type:"scatter3d",mode:"lines",x,y,z,hoverinfo:"skip",showlegend:false,
      line:{color:options.color,width:options.width},name:options.name};
  }
  function meshTrace(points, triangles, options) {
    const coord=pointArrays(points);
    const out={type:"mesh3d",...coord,
      i:triangles.map(t=>t[0]),j:triangles.map(t=>t[1]),k:triangles.map(t=>t[2]),
      opacity:options.opacity,hoverinfo:"skip",flatshading:!!options.cell,
      name:options.name,showlegend:false,
      lighting:{ambient:0.78,diffuse:0.5,specular:0.06,roughness:0.9}};
    if (options.intensity && options.intensity.length) {
      out.intensity=options.intensity;
      out.intensitymode=options.cell ? "cell" : "vertex";
      out.colorbar={title:{text:scalarLabel()},thickness:13,len:0.72,outlinewidth:0};
      out.showscale=true;
      let minV=Infinity,maxV=-Infinity;
      for (const value of options.intensity) {
        minV=Math.min(minV,value); maxV=Math.max(maxV,value);
      }
      const signed=options.signed || (minV<0 && maxV>0);
      if (signed) {
        const absMax=Math.max(Math.abs(minV),Math.abs(maxV),1e-16);
        out.cmin=-absMax;out.cmax=absMax;out.colorscale="RdBu";
      } else out.colorscale="Turbo";
    } else out.color=options.color;
    return out;
  }
  function autoScale() {
    if (!mesh) return 1;
    const ranges=[0,1,2].map(i=>{
      let lo=Infinity,hi=-Infinity;
      for (const point of mesh.xyz) {lo=Math.min(lo,point[i]);hi=Math.max(hi,point[i]);}
      return hi-lo;
    });
    const diag=Math.hypot(...ranges);
    const maxU=mesh.translations.reduce((m,v)=>Math.max(m,norm3(v)),0);
    if (maxU===0 || diag===0) return 1;
    const factor=0.08*diag/maxU;
    return Math.max(0.000001,Math.min(factor,1_000_000));
  }
  function setScale(value) {
    const factor=Math.max(0,Number(value)||0);
    const range=$("fea-scale");
    if (factor>Number(range.max)) range.max=String(Number((factor*2).toPrecision(4)));
    range.value=String(factor);
    $("fea-scale-value").value=String(Number(factor.toPrecision(6)));
  }
  function render() {
    if (!mesh) return;
    if (typeof Plotly==="undefined") {
      showError("Plotly.js unavailable; configure an approved Plotly WebApp JavaScript resource.");return;
    }
    const scale=Math.max(0,Number($("fea-scale-value").value)||0);
    const points=mesh.xyz.map((pos,i)=>[
      pos[0]+scale*mesh.translations[i][0],
      pos[1]+scale*mesh.translations[i][1],
      pos[2]+scale*mesh.translations[i][2],
    ]);
    const tris=mesh.triangles;
    const edges=mesh.edges;
    const original=$("fea-original").checked;
    const wireframe=$("fea-wireframe").checked;
    const markers=$("fea-nodes").checked && mesh.node_ids.length <= 5000;
    const traces=[];
    const stressMode=$("fea-color").value === "stress";
    if (original && tris.length) traces.push(meshTrace(mesh.xyz,tris,{name:"Undeformed",opacity:0.13,color:"#8499b0"}));
    if (tris.length && stressMode) {
      if (!mesh.stress) {showError("Stress data not loaded. Click Visualize mesh.");return;}
      const colored=[],values=[],uncolored=[];
      mesh.stress.triangle_values.forEach((v,i)=>{
        if (Number.isFinite(v)) {colored.push(tris[i]); values.push(v);}
        else uncolored.push(tris[i]);
      });
      if (uncolored.length) traces.push(meshTrace(points,uncolored,{name:"No stress match",opacity:0.45,color:"#b4beca"}));
      if (colored.length) traces.push(meshTrace(points,colored,{name:"Element stress",opacity:1,intensity:values,cell:true}));
    } else if (tris.length) {
      traces.push(meshTrace(points,tris,{name:"Deformed",opacity:1,intensity:meshScalars()}));
    }
    if (wireframe || !tris.length) {
      if (original) traces.push(edgeTrace(mesh.xyz,edges,{color:"rgba(110,134,158,.38)",width:2,name:"Reference edges"}));
      traces.push(edgeTrace(points,edges,{color:"rgba(35,51,68,.75)",width:2.3,name:"Mesh edges"}));
    }
    if (markers) {
      const coord=pointArrays(points);
      const labels=mesh.node_ids.map((nid,i)=>"Node "+nid+"<br>|U|="+fmt(norm3(mesh.translations[i])));
      const marker=stressMode ? {size:2.8,color:"#45576d",opacity:0.8}
                              : {size:2.8,color:meshScalars(),colorscale:"Turbo",showscale:false,opacity:0.9};
      traces.push({type:"scatter3d",mode:"markers",...coord,text:labels,hoverinfo:"text",marker,showlegend:false});
    }
    const layout={margin:{l:2,r:2,t:4,b:2},paper_bgcolor:"#fff",plot_bgcolor:"#fff",
      font:{family:"Inter,Arial,sans-serif",color:"#526478",size:11},showlegend:false,
      uirevision:"fea-preserve-view",
      scene:{aspectmode:"data",
        xaxis:{title:"X",backgroundcolor:"#f9fbfd",gridcolor:"#e2e9f1",zeroline:false},
        yaxis:{title:"Y",backgroundcolor:"#f9fbfd",gridcolor:"#e2e9f1",zeroline:false},
        zaxis:{title:"Z",backgroundcolor:"#f9fbfd",gridcolor:"#e2e9f1",zeroline:false}}};
    const config={responsive:true,displaylogo:false,displayModeBar:true,
      modeBarButtonsToRemove:["lasso2d","select2d"],
      toImageButtonOptions:{format:"png",filename:"fea_"+(stressMode?"stress":"displacements")}};
    Plotly.react("fea-chart",traces,layout,config);
    $("fea-caption").textContent=mesh.files.bdf + " · " +
      (stressMode ? mesh.files.stress_csv : (mesh.files.displacements||"undeformed"));
  }
  function showMetadata() {
    const info=mesh.metadata;
    const maxU=mesh.translations.reduce((m,v)=>Math.max(m,norm3(v)),0);
    const pairs={
      "fea-total-nodes":info.bdf_nodes_total,
      "fea-total-elements":info.bdf_elements_total,
      "fea-visible-nodes":info.displayed_nodes,
      "fea-matched":(info.has_displacements ? info.matched_displacement_nodes+" / "+info.displayed_nodes : "None"),
      "fea-faces":info.rendered_triangles,
      "fea-max-u":maxU.toExponential(4),
      "fea-stress-covered":mesh.stress ? info.stress_colored_triangles+" / "+info.rendered_triangles : "—",
      "fea-stress-range":mesh.stress ? fmt(mesh.stress.min)+" to "+fmt(mesh.stress.max) : "—",
    };
    for (const [key,val] of Object.entries(pairs)) $(key).textContent=typeof val==="number"?fmt(val):val;
    const el=$("fea-warnings");
    const warnings=info.warnings||[];
    el.replaceChildren();el.hidden=warnings.length===0;
    if (warnings.length) {
      const title=document.createElement("strong");title.textContent="Important notes";el.append(title);
      const list=document.createElement("ul");
      for (const message of warnings) {
        const li=document.createElement("li");li.textContent=message;list.append(li);
      }
      el.append(list);
    }
  }
  async function loadMesh() {
    clearError();
    const bdf=$("fea-bdf").value;
    const displacements=$("fea-csv").value;
    const stepStr=$("fea-step").value;
    const mode=$("fea-color").value;
    const stress=mode==="stress";
    const stressCsv=$("fea-stress-csv").value;
    const stressStep=$("fea-stress-step").value;
    if (!bdf || (!displacements && !stress) || (displacements && !stepStr)) {
      showError("Choose a BDF and displacement step, or select Stress coloring and a stress CSV.");return;
    }
    if (stress && (!stressCsv || !stressStep || !$("fea-component").value || !$("fea-layer").value)) {
      showError("Choose a stress CSV, step, component, and ply/surface.");return;
    }
    const gen=++loadGeneration;
    const button=$("fea-load");
    button.disabled=true;status("Loading BDF and results…","working");
    try {
      const payload={
        bdf,displacements,step:stepStr?JSON.parse(stepStr):null,
        color_mode:mode,stress_csv:stress?stressCsv:"",
        stress_step:stress?JSON.parse(stressStep):null,
        stress_component:stress?$("fea-component").value:"",
        stress_layer:stress?$("fea-layer").value:"",
        stress_aggregate:stress?$("fea-aggregate").value:"mean",
      };
      const response=await api("/api/mesh",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});
      if (gen!==loadGeneration) return;
      mesh=response;setScale(autoScale());showMetadata();render();status("Loaded","ok");
    } catch(error) {if (gen===loadGeneration) showError(error.message);}
    finally {button.disabled=false;}
  }
  function mount() {
    $("fea-load").addEventListener("click",loadMesh);
    $("fea-refresh").addEventListener("click",fetchCatalog);
    $("fea-bdf").addEventListener("change",invalidate);
    $("fea-csv").addEventListener("change",()=>{invalidate();fetchSteps();});
    $("fea-step").addEventListener("change",invalidate);
    $("fea-stress-csv").addEventListener("change",()=>{
      if ($("fea-stress-csv").value) $("fea-color").value="stress";
      refreshStressVisibility();invalidate();
      const adjusted=alignDisplacementsToStressFolder();
      if (adjusted) fetchSteps();
      fetchStressOptions();
    });
    for (const id of ["fea-stress-step","fea-component","fea-layer","fea-aggregate"])
      $(id).addEventListener("change",invalidate);
    $("fea-color").addEventListener("change",()=>{
      if ($("fea-color").value==="stress") {
        if (!$("fea-stress-csv").value && $("fea-stress-csv").options.length>1) {
          $("fea-stress-csv").selectedIndex=1;
          if (alignDisplacementsToStressFolder()) fetchSteps();
          fetchStressOptions();
        }
        invalidate();
      } else if (mesh && mesh.stress) invalidate();
      else render();
      refreshStressVisibility();
    });
    for (const id of ["fea-original","fea-wireframe","fea-nodes"]) $(id).addEventListener("change",render);
    $("fea-scale").addEventListener("input",()=>{$("fea-scale-value").value=$("fea-scale").value;render();});
    $("fea-scale-value").addEventListener("change",()=>{setScale($("fea-scale-value").value);render();});
    $("fea-auto").addEventListener("click",()=>{if(mesh){setScale(autoScale());render();}});
    refreshStressVisibility();fetchCatalog();
  }
  if (document.readyState==="loading") document.addEventListener("DOMContentLoaded",mount);
  else mount();
})();
