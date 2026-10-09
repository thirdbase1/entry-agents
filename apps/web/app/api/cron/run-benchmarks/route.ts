export async function POST() {
  return Response.json(
    { error: "Benchmarking has been retired" },
    { status: 410 },
  );
}
