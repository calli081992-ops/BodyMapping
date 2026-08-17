import { HttpError } from "../lib/http-error.js";
import { getAuthenticatedUser, createRequestSupabaseClient } from "../services/supabase.js";

const bearerPrefix = "Bearer ";

export const requireAuthContext = async (req, _res, next) => {
  try {
    const authHeader = req.headers.authorization ?? "";
    if (!authHeader.startsWith(bearerPrefix)) {
      throw new HttpError(401, "Missing bearer access token.");
    }

    const token = authHeader.slice(bearerPrefix.length).trim();
    if (!token) {
      throw new HttpError(401, "Missing bearer access token.");
    }

    const user = await getAuthenticatedUser(token);
    if (!user) {
      throw new HttpError(401, "Invalid access token.");
    }

    const db = createRequestSupabaseClient(token);
    const orgHeader = req.headers["x-organization-id"];

    const membershipsQuery = db
      .from("organization_memberships")
      .select("organization_id, role, therapist:therapists!inner(id, user_id, display_name)")
      .eq("therapist.user_id", user.id);

    if (typeof orgHeader === "string" && orgHeader.trim().length > 0) {
      membershipsQuery.eq("organization_id", orgHeader);
    }

    const { data: memberships, error: membershipError } = await membershipsQuery.limit(1);
    if (membershipError) {
      throw membershipError;
    }
    if (!memberships || memberships.length === 0) {
      throw new HttpError(
        403,
        "No organization membership found. Add X-Organization-Id when user belongs to multiple organizations.",
      );
    }

    const membership = memberships[0];
    req.auth = {
      token,
      userId: user.id,
      organizationId: membership.organization_id,
      role: membership.role,
      therapistId: membership.therapist.id,
      therapistName: membership.therapist.display_name,
    };
    req.db = db;

    next();
  } catch (error) {
    next(error);
  }
};
