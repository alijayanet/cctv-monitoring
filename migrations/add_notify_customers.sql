-- Migration: Add notify_customers column to alert_rules
-- Date: 2026-05-13
-- Description: Allow alerts to be sent to customers in addition to admins

-- Add notify_customers column
ALTER TABLE alert_rules 
ADD COLUMN notify_customers INTEGER DEFAULT 0;

-- 0 = Admin only
-- 1 = Admin + All active customers

-- Update existing rules to admin only (default)
UPDATE alert_rules SET notify_customers = 0;

-- Example: Enable customer notifications for weather alerts
-- UPDATE alert_rules SET notify_customers = 1 WHERE type = 'weather';

-- Made with Bob
