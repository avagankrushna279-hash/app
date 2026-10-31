'use strict';
// Canned model answers for offline testing. They only echo the input, they do not reason.
function mockText(name, input = {}) {
  const biz = (input.business && input.business.name) || (input.profile && input.profile.name) || (input.client && input.client.name) || '[business name]';
  if (name === 'gbp_advisor') {
    const issues = (input.audit && input.audit.issues) || [];
    return JSON.stringify({
      summary: (input.audit && input.audit.summary) + ' Start with the first three fixes below.',
      priorities: issues.slice(0, 3).map((i) => ({ title: i.title, why: i.why, steps: [i.fix], effort_minutes: i.effortMinutes })),
      description: biz + ' offers [main services] in [area]. Our team focuses on clear advice, honest pricing and a comfortable visit. Call or message us on WhatsApp to book an appointment.',
      suggested_services: [{ name: '[Service 1]', description: 'One plain sentence about this service.' }],
      suggested_categories: [], post_ideas: ['Meet the team', 'A common question we get this week', 'Opening hours for the coming holiday'],
    });
  }
  if (name === 'review_reply') {
    const r = Number(input.review && input.review.rating) || 5;
    return JSON.stringify(r <= 2
      ? { reply: 'Thank you for telling us, and we are sorry your experience was not what it should be. Please contact us on [phone or WhatsApp number] so we can look into this properly.', needs_owner: true, reason: 'Low rating' }
      : { reply: 'Thank you for your kind words. We are glad you had a good experience and look forward to seeing you again.', needs_owner: false, reason: '' });
  }
  if (name === 'gbp_post') return JSON.stringify({ body: (input.topic || 'News') + ' at ' + biz + '. Message us on WhatsApp to find out more or to book a time that suits you.', cta: 'BOOK', photo_idea: 'A bright photo of the team or the space' });
  if (name === 'social_content') {
    return JSON.stringify({ hook: 'Did you know?', scenes: [{ seconds: '0-3', visual: 'Close-up of the problem', on_screen_text: 'Did you know?', voiceover: '' }, { seconds: '3-7', visual: 'The solution in action', on_screen_text: 'Here is how', voiceover: '' }, { seconds: '7-10', visual: 'Logo and booking prompt', on_screen_text: 'Book today', voiceover: '' }], image_idea: 'A clean photo of the service', caption: (input.goal || 'Our latest') + '. Message us to book.', hashtags: ['localbusiness', 'thane', 'booknow', 'smallbusiness', 'mumbai'], cta: 'Message us on WhatsApp' });
  }
  if (name === 'whatsapp') {
    const last = input.history && input.history[input.history.length - 1];
    const t = String((last && last.body) || '').toLowerCase();
    const bk = String((last && last.body) || '').match(/book\s+(.+?)\s+(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})(?:\s+as\s+(.+))?/i);
    if (bk) return JSON.stringify({ reply: 'Great, let me check that slot for you.', intent: 'booking', reason: '', booking: { name: bk[4] || 'Customer', service: bk[1], date: bk[2], time: bk[3] } });
    if (/refund|angry|complaint|person|human/.test(t)) return JSON.stringify({ reply: 'I will connect you with our team right away, they will reply shortly.', intent: 'handover', reason: 'customer request', booking: {} });
    return JSON.stringify({ reply: 'Thanks for your message! How can I help you today?', intent: 'faq', reason: '', booking: {} });
  }
  throw new Error('No mock for ' + name);
}
module.exports = { mockText };
