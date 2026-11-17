import { createAdminClient } from "@/lib/supabase/admin";
import type { EventHandler } from "@/lib/event-log/dispatcher";
import { AUTOMATION_CONSUMER_KEY, runAutomationForEvent } from "@/lib/automation/engine";
import { TRIGGER_EVENTS } from "@/lib/schemas/webhooks";
// Importa os executores para que se registrem (side-effect imports — Tasks 9-11):
import "@/lib/automation/actions/register-all";

export const automationRulesHandler: EventHandler = {
  key: AUTOMATION_CONSUMER_KEY,
  // A lista é a do formulário de regras: evento que a tela oferece e o motor não consome seria regra que nunca roda.
  events: [...TRIGGER_EVENTS],
  async handle(row) {
    return runAutomationForEvent(createAdminClient(), row);
  },
};
