/**
 * pi's scripted provider, for a test that runs a window without a model
 * (docs/prompting.md#no-built-in-pi-prompt is about the prompt, not the tests).
 *
 * pi owns its own test doubles, so a package that tests against the pi backend
 * reaches them through here rather than depending on pi itself.
 */

export {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type FauxModelDefinition,
  type FauxProviderHandle,
  type FauxResponseStep,
  type Models,
} from "@earendil-works/pi-ai";
