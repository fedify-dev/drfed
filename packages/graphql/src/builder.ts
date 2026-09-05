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

import { type Database, normalizeEmail, relations } from "@drfed/models";
import {
  type Account,
  type Session,
  instanceMembers,
  instances,
} from "@drfed/models/schema";
import type { Federation } from "@fedify/fedify";
import { Template } from "@fedify/uri-template";
import SchemaBuilder, { type ObjectRef } from "@pothos/core";
import DrizzlePlugin from "@pothos/plugin-drizzle";
import ErrorsPlugin from "@pothos/plugin-errors";
import RelayPlugin from "@pothos/plugin-relay";
import ScopeAuthPlugin from "@pothos/plugin-scope-auth";
import type { Transport } from "@upyo/core";
import { getTableConfig } from "drizzle-orm/pg-core";
import { and, eq, isNotNull } from "drizzle-orm/sql/expressions";
import { DateTimeResolver, URLResolver, UUIDResolver } from "graphql-scalars";

/**
 * The context data for the GraphQL server, which includes the incoming request
 * object and any additional information needed for processing GraphQL queries
 * and mutations.
 */
export interface ServerContext {
  /**
   * The incoming HTTP request.
   */
  readonly request: Request;

  /**
   * The database instance.
   */
  readonly db: Database;

  /**
   * Email sending services.
   */
  readonly mailer: Transport;

  /**
   * Email address to send.
   */
  readonly emailFrom: string;

  /**
   * Origin list.
   */
  readonly origins: ReadonlySet<string>;

  /**
   * Root domain.
   */
  readonly root: string;

  /**
   * The federation instance.
   */
  readonly federation: Federation<unknown>;
}

/**
 * The user-related context data for the GraphQL server, which include every
 * field from the {@link ServerContext}.
 */
export interface UserContext extends ServerContext {
  /**
   * Session information.
   */
  readonly session?: Session;

  /**
   * Current viewer.
   */
  readonly account?: Account;
}

export interface SchemaTypes {
  Context: UserContext;
  Scalars: {
    DateTime: {
      Input: Date;
      Output: Date;
    };
    Email: {
      Input: string;
      Output: string;
    };
    UUID: {
      Input: string;
      Output: string;
    };
    URITemplate: {
      Input: Template;
      Output: Template;
    };
    URL: {
      Input: URL;
      Output: string;
    };
  };
  DefaultFieldNullability: false;
  DrizzleRelations: typeof relations;
  AuthScopes: {
    authenticated: boolean;
    admin: boolean;
    /**
     * Whether the viewer is an accepted member of the `Instance` backed by
     * the `LocalInstance` with the given UUID.
     */
    localInstanceMember: string;
    /**
     * Whether the viewer is the `Account` with the given UUID.
     */
    accountSelf: string;
  };
}

export type DrFedSchemaTypes =
  PothosSchemaTypes.ExtendDefaultTypes<SchemaTypes>;

export type DrFedObjectRef<Shape = unknown, Parent = Shape> = ObjectRef<
  DrFedSchemaTypes,
  Shape,
  Parent
>;

/**
 * The GraphQL schema builder.
 */
export const builder = new SchemaBuilder<SchemaTypes>({
  defaultFieldNullability: false,
  drizzle: {
    client(ctx) {
      return ctx.db;
    },
    getTableConfig,
    relations,
  },
  plugins: [DrizzlePlugin, RelayPlugin, ErrorsPlugin, ScopeAuthPlugin],
  errors: { defaultTypes: [] },
  scopeAuth: {
    authorizeOnSubscribe: true,
    authScopes(context) {
      return {
        authenticated: Boolean(context.session),
        admin: Boolean(context.account?.admin),
        localInstanceMember(localInstanceId) {
          return isLocalInstanceMember(context, localInstanceId);
        },
        accountSelf(accountId) {
          return context.account?.id === accountId;
        },
      };
    },
  },
});

/**
 * Determines whether the viewer is an accepted member of the `Instance` that
 * the given `LocalInstance` backs.  Pending members, i.e. those who have been
 * invited but have not accepted yet, do not count.
 *
 * Pothos caches scope results per request by scope name and parameter, so this
 * runs at most once per `LocalInstance` per request.
 *
 * @param context The request context, whose `account` is the viewer.
 * @param localInstanceId The UUID of the `LocalInstance` to check.
 * @returns Whether the viewer is an accepted member.
 */
async function isLocalInstanceMember(
  context: UserContext,
  localInstanceId: string,
): Promise<boolean> {
  const { account } = context;
  if (account == null) return false;
  const rows = await context.db
    .select({ instanceId: instanceMembers.instanceId })
    .from(instanceMembers)
    .innerJoin(instances, eq(instanceMembers.instanceId, instances.id))
    .where(
      and(
        eq(instances.localId, localInstanceId),
        eq(instanceMembers.accountId, account.id),
        isNotNull(instanceMembers.accepted),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

builder.addScalarType("DateTime", DateTimeResolver);
builder.addScalarType("URL", URLResolver);

builder.scalarType("Email", {
  parseValue: (v) => normalizeEmail(String(v)),
  serialize: (v) => normalizeEmail(v),
});

builder.addScalarType("UUID", UUIDResolver);

builder.scalarType("URITemplate", {
  parseValue(v) {
    if (v instanceof Template) {
      return v;
    }
    return Template.parse(String(v));
  },
  serialize(v) {
    return v.toString();
  },
});

export const Node = builder.nodeInterfaceRef();

export default builder;
