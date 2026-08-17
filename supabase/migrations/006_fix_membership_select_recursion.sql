drop policy if exists membership_self_or_admin_select on organization_memberships;

create policy membership_self_or_admin_select
on organization_memberships
for select
to authenticated
using (
  is_org_member(organization_memberships.organization_id)
);
