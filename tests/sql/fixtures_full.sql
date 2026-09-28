-- Applied after 003 and 004 in the full test template: the owner adds the two
-- analysts through the real RPC, as the console's Team page would.

select tests.as_user('owner@quickserve.test');
select public.staff_add('analyst@quickserve.test', 'Tuyeni Analyst', 'analyst');
select public.staff_add('analyst2@quickserve.test', 'Second Analyst', 'analyst');
select tests.as_postgres();
