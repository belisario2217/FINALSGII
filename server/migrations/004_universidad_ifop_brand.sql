UPDATE institution_settings
SET institution_name = 'Universidad IFOP',
    footer_text = 'Documento académico emitido por Universidad IFOP',
    updated_at = CURRENT_TIMESTAMP
WHERE id = 1;

UPDATE report_templates
SET header_text = 'Universidad IFOP'
WHERE type = 'report_card' AND is_default = 1;
