'use strict';
// Rule-based Google Business Profile audit. Pure functions, no network.
// The thresholds below are practical starting points, NOT Google ranking rules.

const round1 = (n) => Math.round(n * 10) / 10;
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const str = (v) => (typeof v === 'string' ? v.trim() : '');
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const pct = (cur, prev) => (num(prev) > 0 ? round1(((num(cur) - num(prev)) / num(prev)) * 100) : null);

function audit(profile, metrics) {
  const p = profile && typeof profile === 'object' ? profile : {};
  const issues = [];
  const sections = [];
  const sev = (lost, max) => { const r = lost / max; return r >= 0.6 ? 'high' : r >= 0.3 ? 'medium' : 'low'; };
  const add = (id, area, max, earned, title, why, fix, effort) => {
    const lost = max - earned;
    if (lost < 1) return;
    issues.push({ id, area, severity: sev(lost, max), title, why, fix, impact: round1(lost), effortMinutes: effort });
  };
  const close = (id, label, max, earned) => sections.push({ id, label, max, earned: round1(clamp(earned, 0, max)) });

  // ---------------------------------------------------------------- Basics (25)
  let basics = 0;
  const eCat = str(p.primaryCategory) ? 5 : 0; basics += eCat;
  add('primary_category', 'Basics', 5, eCat, 'No primary category',
    'Categories tell Google what the business is, so a missing one limits the searches it can appear in.',
    'Choose the most specific primary category for your main service, not a broad one.', 5);

  const dlen = str(p.description).length;
  let eDesc = 7, dTitle = '';
  if (dlen === 0) { eDesc = 0; dTitle = 'No business description'; }
  else if (dlen > 750) { eDesc = 3; dTitle = 'Description is over the 750-character limit'; }
  else if (dlen < 250) { eDesc = round1((7 * dlen) / 250); dTitle = 'Description is too short (' + dlen + ' characters)'; }
  basics += eDesc;
  add('description', 'Basics', 7, eDesc, dTitle,
    'The description is where you explain your services, the area you serve and what makes you different.',
    'Write 250 to 750 characters covering main services, the area you serve and what makes you different. Avoid links and special offers.', 15);

  const ePhone = str(p.phone) ? 2 : 0; basics += ePhone;
  add('phone', 'Basics', 2, ePhone, 'No phone number', 'Customers who want to call cannot.', 'Add the number that is answered during opening hours.', 2);

  const web = str(p.website);
  const eWeb = web ? (/^https:\/\//i.test(web) ? 2 : 1) : 0; basics += eWeb;
  add('website', 'Basics', 2, eWeb, web ? 'Website link is not secure (http)' : 'No website link',
    web ? 'Visitors may see a security warning.' : 'Customers cannot learn more or book online.',
    web ? 'Switch the link to the https version of your site.' : 'Add your website or a simple booking page.', 3);

  const eHours = p.hoursSet ? 3 : 0; basics += eHours;
  add('hours', 'Basics', 3, eHours, 'Opening hours not set', 'Wrong or missing hours send customers to a closed door.', 'Set regular hours for every day, including closed days.', 5);
  const eHol = p.holidayHoursSet ? 2 : 0; basics += eHol;
  add('holiday_hours', 'Basics', 2, eHol, 'No special hours for holidays', 'Customers see regular hours on days you are actually closed.', 'Add special hours for upcoming holidays and festivals.', 5);

  const eBook = p.bookingLink || p.bookingNotApplicable ? 2 : 0; basics += eBook;
  add('booking_link', 'Basics', 2, eBook, 'No booking or appointment link', 'Viewers who are ready to book have to leave and search again.', 'Add a booking link (a WhatsApp booking link works).', 10);

  const nCat = Array.isArray(p.additionalCategories) ? p.additionalCategories.length : 0;
  const eAddCat = nCat >= 2 ? 2 : nCat;
  basics += eAddCat;
  add('categories', 'Basics', 2, eAddCat, nCat ? 'Only one secondary category' : 'No secondary categories',
    'Secondary categories let the profile appear for related services.', 'Add up to two or three that honestly describe other services you offer.', 5);
  close('basics', 'Basics', 25, basics);

  // ---------------------------------------------------------------- Photos (15)
  const ph = p.photos || {};
  const total = num(ph.total);
  const ePhTotal = (6 * Math.min(total, 10)) / 10;
  add('photos_total', 'Photos', 6, ePhTotal, 'Only ' + total + ' photos',
    'Profiles with few photos give customers little to trust.',
    'Add at least 10 real photos: outside, reception, work area, team and examples of your work (with permission).', 30);
  const rec = num(ph.last30Days);
  const ePhRec = rec >= 3 ? 4 : rec >= 1 ? 2 : 0;
  add('photos_recent', 'Photos', 4, ePhRec, rec ? 'Few new photos this month' : 'No new photos in the last 30 days',
    'Fresh photos show the business is active.', 'Upload 3 or more new photos each month.', 10);
  const eBrand = (ph.hasLogo ? 1.5 : 0) + (ph.hasCover ? 1.5 : 0);
  add('photos_brand', 'Photos', 3, eBrand, !ph.hasLogo && !ph.hasCover ? 'No logo or cover photo' : (!ph.hasLogo ? 'No logo' : 'No cover photo'),
    'The logo and cover photo are the first things people see.', 'Upload a square logo and a clear cover photo.', 10);
  const eTeam = (ph.hasTeam ? 1 : 0) + (ph.hasInterior ? 1 : 0);
  add('photos_team', 'Photos', 2, eTeam, 'No team or inside photos', 'People like to see who they will meet and where.', 'Add a team photo and photos of the inside.', 15);
  close('photos', 'Photos', 15, ePhTotal + ePhRec + eBrand + eTeam);

  // ---------------------------------------------------------------- Reviews (25)
  const rv = p.reviews || {};
  const count = num(rv.count), rating = num(rv.rating);
  const eCount = (7 * Math.min(count, 50)) / 50;
  add('reviews_count', 'Reviews', 7, eCount, 'Only ' + count + ' reviews', 'More reviews build trust and help the profile stand out.',
    'Ask every customer for a review after their visit, with your review link on WhatsApp. Do not offer rewards for reviews.', 20);
  const eRating = count === 0 ? 0 : rating >= 4.5 ? 6 : rating >= 4 ? 4 : rating >= 3.5 ? 2 : 0;
  add('reviews_rating', 'Reviews', 6, eRating, count === 0 ? 'No reviews yet' : 'Average rating is ' + rating,
    'Rating is one of the first things customers compare.', 'Reply to every review and fix the problems that low reviews mention again and again.', 30);
  const answered = clamp(num(rv.answeredPct), 0, 100);
  const eResp = (7 * answered) / 100;
  add('reviews_response', 'Reviews', 7, eResp, 'Only ' + Math.round(answered) + '% of reviews have a reply',
    'Replies show customers and Google that you are paying attention.', 'Reply to every review within 2 days. The review reply agent can draft them.', 20);
  const r30 = num(rv.last30Days);
  const eRecent = r30 >= 3 ? 3 : r30 >= 1 ? 1.5 : 0;
  add('reviews_recent', 'Reviews', 3, eRecent, r30 ? 'Few new reviews this month' : 'No new reviews in the last 30 days',
    'Recent reviews show the business is still doing well.', 'Send your review link to customers right after each visit.', 10);
  const unNeg = num(rv.unansweredNegative);
  const eNeg = unNeg === 0 ? 2 : 0;
  add('reviews_negative', 'Reviews', 2, eNeg, unNeg + ' low-rated review' + (unNeg === 1 ? '' : 's') + ' without a reply',
    'Unanswered complaints are what new customers read first.', 'Reply politely, apologise for the experience and invite them to contact you directly.', 15);
  close('reviews', 'Reviews', 25, eCount + eRating + eResp + eRecent + eNeg);

  // ---------------------------------------------------------------- Activity (15)
  const po = p.posts || {};
  const p30 = num(po.last30Days);
  const ePosts = p30 >= 4 ? 10 : p30 >= 2 ? 6 : p30 >= 1 ? 3 : 0;
  add('posts', 'Activity', 10, ePosts, p30 ? 'Only ' + p30 + ' post' + (p30 === 1 ? '' : 's') + ' in the last 30 days' : 'No posts in the last 30 days',
    'Regular posts keep the profile fresh for people who find it.', 'Publish at least one post a week: an offer, an update or a tip. The post agent can draft them.', 15);
  const since = po.daysSinceLast !== null && po.daysSinceLast !== undefined && Number.isFinite(Number(po.daysSinceLast)) ? num(po.daysSinceLast) : (p30 > 0 ? 30 : 999);
  const ePostRec = since <= 7 ? 5 : since <= 14 ? 3 : since <= 30 ? 1 : 0;
  add('posts_recent', 'Activity', 5, ePostRec, since >= 999 ? 'No posts yet' : 'Last post was ' + since + ' days ago',
    'An old last post makes the profile look inactive.', 'Post something this week.', 15);
  close('activity', 'Activity', 15, ePosts + ePostRec);

  // ---------------------------------------------------------------- Services (10)
  const list = Array.isArray(p.services) ? p.services : [];
  const eSvc = (6 * Math.min(list.length, 8)) / 8;
  add('services_count', 'Services', 6, eSvc, list.length ? 'Only ' + list.length + ' services listed' : 'No services listed',
    'Listed services help the profile match what people search for.', 'List every service you offer, using the words customers use.', 20);
  const described = list.filter((s) => str(s && s.description).length >= 40).length;
  const eSvcD = list.length ? (4 * described) / list.length : 0;
  add('services_desc', 'Services', 4, eSvcD, 'Most services have no description', 'Short descriptions answer questions before customers ask.',
    'Add one or two plain sentences to each service.', 20);
  close('services', 'Services', 10, eSvc + eSvcD);
  if (!Array.isArray(p.attributes) || p.attributes.length === 0) {
    issues.push({ id: 'attributes', area: 'Basics', severity: 'low', title: 'No attributes selected', why: 'Attributes such as accessibility or payment options answer common questions.',
      fix: 'Tick every attribute that is true for the business.', impact: 0, effortMinutes: 5 });
  }

  // ---------------------------------------------------------------- Performance trend (10, only with metrics)
  let performance = null;
  if (metrics && metrics.current) {
    const cur = metrics.current, prev = metrics.previous || {};
    const actions = (m) => num(m.calls) + num(m.directions) + num(m.websiteClicks) + num(m.bookings);
    const rate = (m) => (num(m.impressions) > 0 ? round1((actions(m) / num(m.impressions)) * 100) : null);
    const metric = (k) => ({ current: num(cur[k]), previous: num(prev[k]), changePct: pct(cur[k], prev[k]) });
    performance = {
      period: metrics.period || null,
      impressions: metric('impressions'), calls: metric('calls'), directions: metric('directions'),
      websiteClicks: metric('websiteClicks'), bookings: metric('bookings'),
      actionsPer100Views: { current: rate(cur), previous: rate(prev), changePct: pct(rate(cur), rate(prev)) },
      notes: [],
    };
    const sc = (ch) => (ch === null ? 3 : ch >= 10 ? 5 : ch > -10 ? 3 : ch > -25 ? 1 : 0);
    const iCh = performance.impressions.changePct, rCh = performance.actionsPer100Views.changePct;
    const eImp = sc(iCh), eRate = sc(rCh);
    add('impressions_drop', 'Performance', 5, eImp, 'Fewer people are finding the profile',
      'Searches and map views changed by ' + iCh + '% (' + performance.impressions.previous + ' to ' + performance.impressions.current + ').',
      'Check for recent changes to the profile, add fresh photos and a post, ask for new reviews, and compare with last year in case it is seasonal.', 30);
    add('conversion_drop', 'Performance', 5, eRate, 'Fewer viewers are taking action',
      'Actions per 100 views changed by ' + rCh + '% (' + performance.actionsPer100Views.previous + ' to ' + performance.actionsPer100Views.current + ').',
      'Check the phone number, booking link and hours are correct, add clear service photos and add a booking button.', 20);
    if (iCh !== null && iCh <= -10) performance.notes.push('Views are down ' + Math.abs(iCh) + '% compared with the previous period.');
    if (rCh !== null && rCh <= -10) performance.notes.push('A smaller share of viewers are calling, asking for directions or visiting the website.');
    if (iCh !== null && rCh !== null && iCh >= 10 && rCh <= -10) performance.notes.push('Views rose but actions fell: the profile is being seen but not convincing people.');
    close('trend', 'Performance trend', 10, eImp + eRate);
  }

  const max = sections.reduce((a, s) => a + s.max, 0);
  const earned = sections.reduce((a, s) => a + s.earned, 0);
  const score = Math.round((100 * earned) / max);
  const grade = score >= 85 ? 'A' : score >= 70 ? 'B' : score >= 55 ? 'C' : score >= 40 ? 'D' : 'F';
  const sevRank = { high: 0, medium: 1, low: 2 };
  issues.sort((a, b) => b.impact - a.impact || sevRank[a.severity] - sevRank[b.severity]);
  const quickWins = issues.filter((i) => i.effortMinutes <= 15 && i.impact > 0).slice(0, 5);
  const weakest = sections.slice().sort((a, b) => a.earned / a.max - b.earned / b.max).slice(0, 2).map((s) => s.label);
  return { score, grade, sections, issues, quickWins, performance, summary: 'Score ' + score + '/100 (' + grade + '). Biggest gaps: ' + weakest.join(' and ') + '.' };
}

module.exports = { audit };
