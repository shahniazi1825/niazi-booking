// Clinic-specific display settings. Fill from the clinic intake form (see CLIENT_HANDOVER_PLAN.md section 1).
// Nothing here is secret. Leave a value null to hide it.
window.AVENSO_CONFIG = {
  clinicName: null,            // null = use the name from the booking system
  clinicPhone: null,           // e.g. "+1 868 555 0100" — shown for "call us" and emergencies once confirmed by the clinic
  emergencyNumber: null,       // local emergency services number, e.g. "811"; null = "your local emergency number"
  privacyUrl: null             // link to the clinic privacy notice
};
