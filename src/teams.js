import { HttpError } from './util.js';

// Hosts used by Microsoft Teams incoming webhooks and Power Automate "Workflows".
const TEAMS_HOST_SUFFIXES = [
  '.webhook.office.com',
  '.logic.azure.com',
  '.api.powerplatform.com',
  '.powerplatform.com',
  '.powerautomate.com',
];

export function validateTeamsUrl(raw, config) {
  if (!raw) return null;
  let url;
  try {
    url = new URL(String(raw).trim());
  } catch {
    throw new HttpError(400, 'La URL del webhook de Teams no es válida.');
  }
  const host = url.hostname.toLowerCase();
  const extra = config.teamsExtraHosts.includes(host);
  const official = url.protocol === 'https:' && TEAMS_HOST_SUFFIXES.some((s) => host.endsWith(s));
  if (!official && !extra) {
    throw new HttpError(
      400,
      'La URL debe ser un webhook de Microsoft Teams o de Power Automate (Workflows) y comenzar con https://',
    );
  }
  if (url.toString().length > 2000) throw new HttpError(400, 'La URL del webhook es demasiado larga.');
  return url.toString();
}

/** Adaptive Card payload accepted by both Teams Workflows webhooks and legacy incoming webhooks. */
export function buildCard({ title, subtitle, facts = [], text, linkUrl, linkTitle = 'Abrir en Leap Attendance Hub' }) {
  const body = [
    { type: 'TextBlock', text: title, weight: 'Bolder', size: 'Medium', wrap: true },
  ];
  if (subtitle) body.push({ type: 'TextBlock', text: subtitle, isSubtle: true, spacing: 'None', wrap: true });
  if (facts.length) {
    body.push({ type: 'FactSet', facts: facts.filter((f) => f.value).map((f) => ({ title: f.title, value: String(f.value) })) });
  }
  if (text) body.push({ type: 'TextBlock', text, wrap: true });

  const content = {
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    type: 'AdaptiveCard',
    version: '1.4',
    msteams: { width: 'Full' },
    body,
  };
  if (linkUrl && linkUrl.startsWith('https://')) {
    content.actions = [{ type: 'Action.OpenUrl', title: linkTitle, url: linkUrl }];
  }
  return {
    type: 'message',
    attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', contentUrl: null, content }],
  };
}

export async function postToTeams(url, card) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(card),
    redirect: 'error',
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) {
    const text = (await res.text().catch(() => '')).slice(0, 200);
    throw new Error(`Teams respondió ${res.status}${text ? `: ${text}` : ''}`);
  }
}
