import { auth } from "@/lib/auth/config";

export async function GET(request: Request) {
  const accounts = await auth.api.listUserAccounts({
    headers: request.headers,
  });

  return Response.json({
    providers: accounts.map((account) => account.providerId),
  });
}
