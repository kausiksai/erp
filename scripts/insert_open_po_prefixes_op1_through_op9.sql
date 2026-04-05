-- Open PO prefixes: OP1 … OP9 (pfx matches UPPER(prefix) || '%')
INSERT INTO open_po_prefixes (prefix, description) VALUES
('OP1', 'Open PO — PFX starting with OP1'),
('OP2', 'Open PO — PFX starting with OP2'),
('OP3', 'Open PO — PFX starting with OP3'),
('OP4', 'Open PO — PFX starting with OP4'),
('OP5', 'Open PO — PFX starting with OP5'),
('OP6', 'Open PO — PFX starting with OP6'),
('OP7', 'Open PO — PFX starting with OP7'),
('OP8', 'Open PO — PFX starting with OP8'),
('OP9', 'Open PO — PFX starting with OP9')
ON CONFLICT (prefix) DO UPDATE SET
  description = EXCLUDED.description,
  updated_at = NOW();
