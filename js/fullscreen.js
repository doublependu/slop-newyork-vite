// iPhone Safari has no Fullscreen API, so callers hide their buttons there; iPad Safari still needs the prefix.

const root = document.documentElement;
const fullscreenSupported = Boolean(document.fullscreenEnabled ?? document.webkitFullscreenEnabled);

function fullscreenElement() {
  return document.fullscreenElement ?? document.webkitFullscreenElement ?? null;
}

function toggleFullscreen() {
  if (fullscreenElement()) return (document.exitFullscreen ?? document.webkitExitFullscreen).call(document);
  return (root.requestFullscreen ?? root.webkitRequestFullscreen).call(root);
}

function onFullscreenChange(listener) {
  document.addEventListener('fullscreenchange', listener);
  document.addEventListener('webkitfullscreenchange', listener);
}

export { fullscreenElement, fullscreenSupported, onFullscreenChange, toggleFullscreen };
