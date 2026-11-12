/**
 * Ambient types for the DeepSeek Harness services this plugin consumes.
 *
 * The published `@deepseek-ai/dsh` runtime is large, so it is not a dev
 * dependency; these declarations keep `tsc --checkJs` useful without pulling
 * the whole Host into the repository. They are intentionally loose: the real
 * service contracts are exercised by the Host smoke test.
 */

import '@deepseek-ai/cordis'

declare module '@deepseek-ai/cordis' {
  interface Context {
    sessions?: any
    connection?: any
    webServer?: any
    llm?: any
    agentDefaultModel?: any
  }

  /**
   * The `@deepseek-ai/cordis` runtime is loader-agnostic: the currently
   * mounted Loader entry is attached to the plugin fiber by the DSH loader
   * plugin, not by the core package, so its shape is declared here.
   */
  interface Fiber {
    entry?: { options?: { id?: string } }
  }
}
