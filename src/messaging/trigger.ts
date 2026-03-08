import { TRIGGER_PATTERN } from '../config.js';
import { NewMessage } from '../types.js';

/** Check whether any message in the batch matches the assistant trigger pattern. */
export function hasTriggerMessage(messages: NewMessage[]): boolean {
  return messages.some((m) => TRIGGER_PATTERN.test(m.content.trim()));
}
