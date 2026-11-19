-- allow_negative accounts (funding and other system accounts) stop keeping a cached balance.
-- Nothing ever checks their balance, so nothing needs to lock or update their row; their
-- balance is computed from transfer history when read. This removes the single row that every
-- top-up for a tenant used to wait on. Evidence and trade-offs: ADR 0006, docs/perf/.
--
-- Safe while old code is still running: an old instance doing
-- `balance = balance + x` on a NULL balance leaves it NULL, and never checks it.

alter table accounts alter column balance drop not null;

update accounts set balance = null where allow_negative;

-- NOT VALID + VALIDATE: add the rule without holding a long lock on a live table.
alter table accounts
  add constraint balance_cached_iff_checked check ((balance is null) = allow_negative) not valid;
alter table accounts validate constraint balance_cached_iff_checked;
