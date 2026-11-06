import type { Standing } from '@/lib/plan-standing';
import { hoursWords } from '@/lib/watch-rules';
/** Describe playback admission. Nothing is charged after use (232 [CA1]
 * unit 3), so the notice never mentions a charge, and payment never turns an
 * exhausted playback allowance into an unlimited entitlement.
 */
export function videoUsageNotice(input: { seconds: number; limit: number; standing: Standing; studioUrl: string; supportEmail: string }): {subject: string; text: string} {
  const paused = input.seconds >= input.limit;
  const owner = input.standing === 'paid' ? 'your paid plan' : input.standing === 'trial' ? 'your free trial' : 'a store without an active paid plan';
  return {
    subject: paused ? 'Your lesson videos are paused' : 'Your monthly lesson video usage',
    text: [
      `Your lesson videos have been watched for ${hoursWords(input.seconds)} this month.`,
      `The recorded monthly playback threshold for ${owner} is ${hoursWords(input.limit)}.`,
      '',
      paused ? 'New stream playback is paused until monthly capacity is available again.' : 'Your studio shows the recorded hours and remaining playback capacity.',
      'Watching is measured about once an hour. Existing player links may remain valid until they expire.',
      'Other course content remains available. Video delivered as a file follows the separate download path.',
      '', input.studioUrl, '', `Questions? Write to ${input.supportEmail}.`,
    ].join('\n'),
  };
}
