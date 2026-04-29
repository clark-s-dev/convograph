/**
 * Public surface of the config module.
 */

export {
  parseConfig,
  loadConfig,
  expandEnvVars,
  isConvographConfigError,
  isConvographYamlSyntaxError,
  type ParseOptions,
} from "./parser";

export {
  ConvographConfigError,
  ConvographYamlSyntaxError,
  fromZodError,
  type FormattedIssue,
} from "./errors";

export {
  configSchema,
  topicSchema,
  slotSchema,
  type ConvographConfig,
  type Topic,
  type Slot,
} from "./schema";
