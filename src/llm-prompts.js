'use strict';
// Prompt templates for the local LLM helper (src/llm.js), one per task type.
// Each template owns its instructions, 1-2 worked examples, its output limit and its output format,
// so a job only says *what* it wants (task + options), never how to prompt the model.
// Templates are checked against known answers by scripts/llm-eval.js; rerun it after editing one.

// Turns ["urgent", "reply"] plus optional descriptions into the "Labels:" block shown to the model.
function labelBlock(labels) {
  return labels.map((l) => (l.description ? `- ${l.name}: ${l.description}` : `- ${l.name}`)).join('\n');
}

const TASKS = {
  // Pick exactly one label. Output is constrained by a JSON schema whose enum is the allowed labels.
  classify: {
    numPredict: 20,
    schema: (opts) => ({
      type: 'object',
      properties: { label: { type: 'string', enum: opts.labels.map((l) => l.name) } },
      required: ['label'],
    }),
    messages: (opts, input) => [
      {
        role: 'system',
        content:
          'You are a text classifier. Read the text and choose exactly one label from the allowed labels. ' +
          'Use the label descriptions when given. Reply only with JSON: {"label": "<one allowed label>"}.',
      },
      {
        role: 'user',
        content:
          'Labels:\n- bug: something is broken\n- feature: a request for new behavior\n- question: asking how something works\n\n' +
          'Text:\nThe export button does nothing when I click it since yesterday\'s update.',
      },
      { role: 'assistant', content: '{"label": "bug"}' },
      {
        role: 'user',
        content:
          'Labels:\n- bug: something is broken\n- feature: a request for new behavior\n- question: asking how something works\n\n' +
          'Text:\nIs there a way to change the date format on reports?',
      },
      { role: 'assistant', content: '{"label": "question"}' },
      { role: 'user', content: `Labels:\n${labelBlock(opts.labels)}\n\nText:\n${input}` },
    ],
    format: (obj) => obj.label,
  },

  // Pull named fields out of text. Every field is a string, or null when the text doesn't say.
  extract: {
    numPredict: 200,
    schema: (opts) => ({
      type: 'object',
      properties: Object.fromEntries(opts.fields.map((f) => [f, { type: ['string', 'null'] }])),
      required: opts.fields,
    }),
    messages: (opts, input) => [
      {
        role: 'system',
        content:
          'You extract facts from text. Return JSON with exactly the requested fields. Copy values as they appear ' +
          'in the text, kept short. Use null for any field the text does not state. Never guess or invent values.',
      },
      {
        role: 'user',
        content:
          'Fields: vendor, invoice_number, amount, due_date\n\n' +
          'Text:\nHi, attached is invoice INV-2291 from Northwind Supply for $1,240.00. Payment is due by March 3.',
      },
      {
        role: 'assistant',
        content: '{"vendor": "Northwind Supply", "invoice_number": "INV-2291", "amount": "$1,240.00", "due_date": "March 3"}',
      },
      {
        role: 'user',
        content: 'Fields: person, meeting_time, location\n\nText:\nCan we push our sync to Thursday at 2pm? Thanks, Priya',
      },
      { role: 'assistant', content: '{"person": "Priya", "meeting_time": "Thursday at 2pm", "location": null}' },
      { role: 'user', content: `Fields: ${opts.fields.join(', ')}\n\nText:\n${input}` },
    ],
    format: (obj) => JSON.stringify(obj),
  },

  // One to three plain sentences. No schema; the output cap keeps it short.
  'summarize-short': {
    numPredict: 120,
    schema: null,
    messages: (_opts, input) => [
      {
        role: 'system',
        content:
          'You summarize text in 1 to 3 short, plain sentences. State the main point and any action or deadline. ' +
          'No preamble, no bullet points, no quotes.',
      },
      {
        role: 'user',
        content:
          'Text:\nTeam, the office will be closed Monday for the holiday. The network maintenance originally planned ' +
          'for Monday night moves to Tuesday 10pm. Expect about 30 minutes of downtime. Please save your work before leaving Tuesday.',
      },
      {
        role: 'assistant',
        content:
          'The office is closed Monday for the holiday. Network maintenance moves to Tuesday at 10pm with about 30 minutes of downtime, so save work before leaving Tuesday.',
      },
      { role: 'user', content: `Text:\n${input}` },
    ],
    format: (text) => text.trim(),
  },
};

module.exports = { TASKS };
