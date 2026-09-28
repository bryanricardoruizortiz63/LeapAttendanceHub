import { assert, assertEquals } from 'jsr:@std/assert@1';
import { buildCard, fmtRangeEs, isTeamsUrl, scheduleText } from './teams.ts';

Deno.test('accepts only Microsoft Teams / Power Automate webhook URLs', () => {
  assert(isTeamsUrl('https://prod-12.westus.logic.azure.com:443/workflows/abc/triggers/manual/paths/invoke?sig=x'));
  assert(isTeamsUrl('https://contoso.webhook.office.com/webhookb2/abc'));
  assert(isTeamsUrl('https://default123.45.environment.api.powerplatform.com:443/powerautomate/automations/direct/workflows/x'));
  assert(!isTeamsUrl('http://contoso.webhook.office.com/webhookb2/abc'));
  assert(!isTeamsUrl('https://evil.example.com/logic.azure.com'));
  assert(!isTeamsUrl('https://logic.azure.com.evil.example/'));
  assert(!isTeamsUrl(null));
});

Deno.test('builds an adaptive card and skips empty facts', () => {
  const card = buildCard({
    title: 'Nueva ausencia',
    subtitle: 'Escuela Demo',
    facts: [
      { title: 'Empleado', value: 'María' },
      { title: 'Causa', value: null },
    ],
    linkUrl: 'https://example.org/app/#/absence/1',
  });
  const content = card.attachments[0].content as Record<string, unknown>;
  assertEquals(card.attachments[0].contentType, 'application/vnd.microsoft.card.adaptive');
  const factSet = (content.body as { type: string; facts?: unknown[] }[]).find((b) => b.type === 'FactSet');
  assertEquals(factSet?.facts, [{ title: 'Empleado', value: 'María' }]);
  assertEquals((content.actions as { url: string }[])[0].url, 'https://example.org/app/#/absence/1');
});

Deno.test('formats dates and schedules in Spanish', () => {
  assertEquals(fmtRangeEs('2026-09-24', '2026-09-24'), 'Jueves, 24 de septiembre');
  assertEquals(fmtRangeEs('2026-09-24', '2026-09-25'), 'Jueves, 24 de septiembre al viernes, 25 de septiembre');
  assertEquals(scheduleText({ partial: false, start_time: null, end_time: null }), 'Día completo');
  assertEquals(scheduleText({ partial: true, start_time: '08:00:00', end_time: '10:30:00' }), '08:00 – 10:30');
});
