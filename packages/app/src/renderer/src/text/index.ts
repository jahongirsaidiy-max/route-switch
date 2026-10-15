// The UI's words for codes and states, over the dictionary (`src/i18n`).
// Every function takes the screen's `useI18n()` value as its last argument;
// without it, and in the constants, the words are Uzbek (TASK-DELTA-11: the
// screens move to their language in TASK-DELTA-12/13/14).
export { errorText, UZ, type Feedback } from './errors';
export {
  HELPER_STATUS_TEXT,
  INSTALL_TEXT,
  LOADING_NOTICE,
  helperNotice,
  helperStatusText,
  loadingNotice,
  type HelperNotice,
  type HelperRecovery,
  type HelperStatusText,
} from './helper';
export { LAST_KNOWN_SHOWN, lastKnownShort, lastKnownText, networkWarnings, sameSubnetGateway, type NetworkWarning } from './network';
export { RECONCILE_REASON_TEXT, RULE_REASON_TEXT, isActiveWarning, ruleReasonText } from './rules';
export { formatAgo, formatClock } from './time';
export { configIssueText, isValidationCode, VALIDATION_TEXT } from './validation';
