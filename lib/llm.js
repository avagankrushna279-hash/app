'use strict';
// Chooses the live model or the offline mock (MOCK_LLM=1) so the whole kit can be tested without an API key.
const { complete } = require('./claude');
const { mockText } = require('./mock');
module.exports = async function llm(request, name, input) {
  if (process.env.MOCK_LLM === '1') return mockText(name, input);
  return complete(request);
};
