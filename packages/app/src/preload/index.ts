// Runs in every window before the page, under `sandbox: true` — so it is built
// as a single CommonJS file with its dependencies bundled in.
//
// Nothing is exposed to the page yet. The renderer API (`window.rs`) is added
// here with `contextBridge.exposeInMainWorld`, as thin `ipcRenderer.invoke`
// wrappers and nothing else.

export {};
