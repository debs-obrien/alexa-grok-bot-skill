/** Minimal Alexa response shape (no ask-sdk dependency). */
export type Response = {
  outputSpeech?: { type: "PlainText"; text: string };
  reprompt?: { outputSpeech: { type: "PlainText"; text: string } };
  shouldEndSession?: boolean;
};

/** Short spoken acknowledgements — always finish well under Alexa's ~8s limit. */
export const SPEECH = {
  welcome:
    "Chief of staff here. What should I take care of?",
  help:
    "Say something like: what's on my calendar tomorrow, or draft a reply to Alex. I'll wake chief of staff and get started.",
  goodbye: "Okay. Goodbye.",
  fallback:
    "I didn't catch that. Try asking about your calendar, or tell me what to draft.",
  ackSuccess: "On it — I've woken chief of staff.",
  ackEmptyQuery:
    "What should I ask chief of staff? For example, what's on my calendar tomorrow.",
  ackWakeFailed:
    "I couldn't reach chief of staff — try again from the app.",
} as const;

export function speak(
  text: string,
  options: { endSession?: boolean; reprompt?: string } = {},
): Response {
  const endSession = options.endSession ?? true;
  const response: Response = {
    outputSpeech: {
      type: "PlainText",
      text,
    },
    shouldEndSession: endSession,
  };

  if (!endSession && options.reprompt) {
    response.reprompt = {
      outputSpeech: {
        type: "PlainText",
        text: options.reprompt,
      },
    };
  }

  return response;
}

/** Full Alexa skill response envelope (what the HTTPS endpoint returns). */
export function skillResponse(response: Response): {
  version: string;
  response: Response;
} {
  return {
    version: "1.0",
    response,
  };
}
