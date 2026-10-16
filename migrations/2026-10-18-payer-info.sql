-- Who paid: the name / email entered by the customer (card) and the phone number (MonCash / Natcash), shown to the merchant.
alter table payments add column if not exists customer_name text;
alter table payments add column if not exists customer_email text;
alter table payments add column if not exists customer_phone text;
