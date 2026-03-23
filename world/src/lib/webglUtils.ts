export function canUseWebGL(): boolean {
  try {
    const canvas = document.createElement('canvas');
    const gl2 = canvas.getContext('webgl2', { antialias: false });
    if (gl2) return true;
    const gl =
      canvas.getContext('webgl', { antialias: false }) ||
      canvas.getContext('experimental-webgl', { antialias: false });
    return gl != null;
  } catch {
    return false;
  }
}
