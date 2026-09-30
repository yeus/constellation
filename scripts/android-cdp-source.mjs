import { transformWithEsbuild } from 'vite'

export const compileAndroidWebViewExpression = async (expression) => {
  const { code } = await transformWithEsbuild(expression, 'android-cdp-expression.js', {
    loader: 'js',
    target: 'chrome74',
  })
  return code
}
