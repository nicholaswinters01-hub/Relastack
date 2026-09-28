-- Rows for the plan comparison page that are not modules. Modules come from
-- plan_modules, so the page can never promise what a plan does not unlock.

ALTER TABLE "plans" ADD COLUMN "comparison_extras" JSONB NOT NULL DEFAULT '[]';

UPDATE "plans" SET "comparison_extras" = '[
  {"label": "Industry packs", "value": "$35/mo each", "comingSoon": true},
  {"label": "Customer portal", "value": false, "comingSoon": true},
  {"label": "QuickBooks sync", "value": false, "comingSoon": true},
  {"label": "Support", "value": "Help desk", "comingSoon": false}
]'::jsonb WHERE "key" = 'core';

UPDATE "plans" SET "comparison_extras" = '[
  {"label": "Industry packs", "value": "1 included, more $35/mo", "comingSoon": true},
  {"label": "Customer portal", "value": true, "comingSoon": true},
  {"label": "QuickBooks sync", "value": true, "comingSoon": true},
  {"label": "Support", "value": "Faster replies", "comingSoon": false}
]'::jsonb WHERE "key" = 'pro';

UPDATE "plans" SET "comparison_extras" = '[
  {"label": "Industry packs", "value": "2 included, more $35/mo", "comingSoon": true},
  {"label": "Customer portal", "value": true, "comingSoon": true},
  {"label": "QuickBooks sync", "value": true, "comingSoon": true},
  {"label": "Support", "value": "Priority, with setup help", "comingSoon": false}
]'::jsonb WHERE "key" = 'business_v2';
