-- Virtualobby Seed Data
-- Demo clinic with 5 intake questions

INSERT INTO businesses (id, name, business_type, welcome_message, voice_persona, requires_id_scan)
VALUES ('clinic-main', 'Demo Clinic', 'clinic', 'Welcome to Demo Clinic! I will help you check in for your visit.', 'anna', 1);

INSERT INTO business_questions (id, business_id, field_key, question_text, order_index, validation_type) VALUES
  ('q-apt-1', 'clinic-main', 'appointment', 'Do you have an appointment today?', 1, 'yes_no'),
  ('q-apt-2', 'clinic-main', 'doctor_name', 'Which doctor are you visiting?', 2, 'text'),
  ('q-apt-3', 'clinic-main', 'reason', 'What is the reason for your visit?', 3, 'text'),
  ('q-apt-4', 'clinic-main', 'insurance', 'Do you have insurance?', 4, 'yes_no'),
  ('q-apt-5', 'clinic-main', 'emergency_contact', 'What is your emergency contact phone number?', 5, 'text');
