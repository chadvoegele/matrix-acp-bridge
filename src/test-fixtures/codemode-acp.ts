// Captured from Pi 1.0.0 through the Pi ACP fork with an isolated localhost model.
// Only tool notifications retained; session ID replaced. The script calls no tools.
export const codemodeAcpNotifications = [
  {
    sessionId: "codemode-session",
    update: {
      sessionUpdate: "tool_call",
      toolCallId: "codemode-call",
      title: "codemode",
      kind: "other",
      status: "pending",
      rawInput: {
        code: "const tag = '<sample>';\nreturn { tag, answer: 2 + 3 };",
      },
    },
  },
  {
    sessionId: "codemode-session",
    update: {
      sessionUpdate: "tool_call_update",
      toolCallId: "codemode-call",
      status: "in_progress",
      rawInput: {
        code: "const tag = '<sample>';\nreturn { tag, answer: 2 + 3 };",
      },
    },
  },
  {
    sessionId: "codemode-session",
    update: {
      sessionUpdate: "tool_call_update",
      toolCallId: "codemode-call",
      status: "completed",
      content: [
        {
          type: "content",
          content: {
            type: "text",
            text: 'Script completed\nWall time 0.0 seconds\nOutput:\n{"tag":"<sample>","answer":5}',
          },
        },
      ],
      rawOutput: {
        content: [
          {
            type: "text",
            text: "Script completed\nWall time 0.0 seconds\nOutput:\n",
          },
          {
            type: "text",
            text: '{"tag":"<sample>","answer":5}',
          },
        ],
        details: {
          calls: [],
        },
      },
    },
  },
] as const;
