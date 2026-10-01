const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('orbitDesktop', {
  isDesktop: true,
  openProject: () => ipcRenderer.invoke('orbit:open-project'),
  saveProject: payload => ipcRenderer.invoke('orbit:save-project', payload),
  setBusy: busy => ipcRenderer.send('orbit:busy', busy === true),
  onCommand: callback => {
    if (typeof callback !== 'function') throw new TypeError('A callback is required');
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('orbit:command', listener);
    return () => ipcRenderer.removeListener('orbit:command', listener);
  },
});
