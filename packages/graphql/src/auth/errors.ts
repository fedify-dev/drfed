// DrFed: A web-based platform for developing and debugging ActivityPub apps
// Copyright (C) 2026 DrFed team
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <https://www.gnu.org/licenses/>.
// oxlint-disable func-names func-style id-length

// oxlint-disable max-classes-per-file no-throw-literal
export class Throwable extends Error {
  throw(): never {
    throw this;
  }
}

export class LoginChallengeError extends Throwable {
  constructor(message: string) {
    super("Error while login challenge.");
    this.name = "LoginChallengeError";
    this.message = message;
  }
}

export class VerifyUrlExpandingError extends Throwable {
  constructor(message: string) {
    super("Error while expand verify URL.");
    this.name = "VerifyUrlExpandingError";
    this.message = message;
  }
}

export function throwError(error: Error): never {
  throw error;
}
