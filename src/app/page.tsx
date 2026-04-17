export default function LandingPage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-white px-6">
      <h1 className="text-4xl font-semibold tracking-tight text-gray-900">
        halpmeAIML
      </h1>
      <p className="mt-3 max-w-lg text-center text-lg text-gray-500">
        Learn ML from the papers that matter. An AI tutor grounded in real
        research — every explanation cites the source.
      </p>
      <a
        href="/api/auth/login"
        className="mt-8 rounded-lg bg-blue-600 px-6 py-3 text-sm font-medium text-white hover:bg-blue-700"
      >
        Sign in with Google
      </a>
      <p className="mt-12 max-w-md text-center text-xs text-gray-400">
        AI-generated explanations may contain errors. Always verify claims
        against cited sources.
      </p>
    </main>
  );
}
