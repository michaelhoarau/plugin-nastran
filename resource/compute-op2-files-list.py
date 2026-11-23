import dataiku

def do(payload, config, plugin_config, inputs):
    root_model = payload.get("rootModel", {})
    folder_id = root_model.get('managed_folder')
    folder = dataiku.Folder(folder_id)
    choices = []
    
    for filename in folder.list_paths_in_partition():
        if (filename[-3:] == "op2"):
            choices.append({"value": filename, "label": filename})
    
    return { "choices": choices }