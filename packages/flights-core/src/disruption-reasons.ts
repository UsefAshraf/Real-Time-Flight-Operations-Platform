export const DELAY_REASONS = [
  'Late inbound aircraft',
  'Air traffic control restrictions',
  'Weather',
  'Technical inspection',
  'Crew scheduling',
  'Ground handling',
  'Airport congestion',
  'Security screening',
] as const;

export const DELAY_MINUTES = [10, 15, 20, 30, 45, 60, 90, 120] as const;

export const CANCELLATION_REASONS = [
  'Technical fault',
  'Severe weather',
  'Operational reasons',
  'Crew unavailability',
] as const;

export const DIVERSION_REASONS = [
  'Weather at destination',
  'Medical emergency on board',
  'Technical precaution',
  'Runway closure at destination',
] as const;
