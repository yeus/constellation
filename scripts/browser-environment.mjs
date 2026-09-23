export const browserProcessEnvironment = (environment) => {
  const browserEnvironment = { ...environment }
  delete browserEnvironment.LD_LIBRARY_PATH
  return browserEnvironment
}
