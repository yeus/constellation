export const browserProcessEnvironment = (environment) => {
  const browserEnvironment = { ...environment }
  delete browserEnvironment.LD_LIBRARY_PATH
  // These launches are headless. Host display settings can make ANGLE attempt
  // an inaccessible X server and prevent otherwise working WebGL initialization.
  delete browserEnvironment.DISPLAY
  delete browserEnvironment.WAYLAND_DISPLAY
  delete browserEnvironment.XAUTHORITY
  return browserEnvironment
}
