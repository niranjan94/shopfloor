/**
 * Mirrors @octokit/request-error closely enough for GitHubAdapter's
 * `(err as { status?: number }).status` checks (removeLabel, createLabel)
 * to behave the same way against the fake.
 */
export class FakeRequestError extends Error {
  readonly status: number;
  readonly response: {
    data: { message: string; documentation_url: string };
  };

  constructor(status: number, message: string) {
    super(message);
    this.name = "FakeRequestError";
    this.status = status;
    this.response = {
      data: {
        message,
        documentation_url: "https://docs.github.com/rest",
      },
    };
  }
}
