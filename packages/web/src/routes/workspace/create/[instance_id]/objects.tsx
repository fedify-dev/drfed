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

/* eslint-disable unicorn/no-null -- Kobalte requires null for an empty selection. */

import { Select } from "@kobalte/core/select";
import { TextField } from "@kobalte/core/text-field";
import { Title } from "@solidjs/meta";
import {
  type RouteDefinition,
  type RouteSectionProps,
  query,
} from "@solidjs/router";
import { graphql } from "relay-runtime";
import { Show, createSignal } from "solid-js";
import {
  createMutation,
  createPreloadedQuery,
  loadQuery,
  useRelayEnvironment,
} from "solid-relay";
import * as v from "valibot";

import { showToast } from "~/components/Toast.tsx";
import { actorLabel } from "~/label.ts";

import type { CreateObjectMutation } from "./__generated__/CreateObjectMutation.graphql.ts";
import type { InstanceActorListQuery } from "./__generated__/InstanceActorListQuery.graphql.ts";

import styles from "~/styles/form.module.css";
import objectStyles from "~/styles/object.module.css";

const instanceActorListQuery = graphql`
  query InstanceActorListQuery($instanceId: ID!) {
    instance: node(id: $instanceId) {
      ... on Instance {
        id
        host
        url
        actors(first: 100) {
          totalCount
          edges {
            node {
              handle
              iri
              id
            }
          }
        }
      }
    }
  }
`;

const createObjectMutation = graphql`
  mutation CreateObjectMutation(
    $actor: ID!
    $contentHtml: String!
    $type: ObjectType!
    $addressing: AddressingInput!
    $name: String
  ) {
    createObject(
      actor: $actor
      contentHtml: $contentHtml
      type: $type
      addressing: $addressing
      name: $name
    ) {
      resultType: __typename
      ... on Object {
        id
      }
      ... on CreateObjectError {
        message
      }
    }
  }
`;

const recipientSchema = v.pipe(v.string(), v.url());
const recipientsSchema = v.optional(v.array(recipientSchema), []);
const createObjectSchema = v.object({
  actor: v.pipe(v.string("Select an actor."), v.nonEmpty("Select an actor.")),
  name: v.string(),
  contentHtml: v.pipe(
    v.string(),
    v.check((content) => content.trim() !== "", "Enter content."),
  ),
  type: v.picklist(["Note", "Article"]),
  addressing: v.strictObject({
    to: recipientsSchema,
    cc: recipientsSchema,
    bto: recipientsSchema,
    bcc: recipientsSchema,
    audience: recipientsSchema,
  }),
});

const loadInstanceActorListQuery = query(
  (instanceId: string) =>
    loadQuery<InstanceActorListQuery>(
      useRelayEnvironment()(),
      instanceActorListQuery,
      { instanceId },
    ),
  "InstanceActorListQuery",
);

export const route = {
  preload({ params }) {
    if (params.instance_id === undefined) {
      throw new Error("Missing instance_id route parameter.");
    }
    return loadInstanceActorListQuery(params.instance_id);
  },
} satisfies RouteDefinition;

type RouteData = ReturnType<typeof loadInstanceActorListQuery>;
interface ActorOption {
  readonly id: string;
  readonly label: string;
}
const actorOptions = (
  edges: readonly {
    readonly node: Parameters<typeof actorLabel>[0] & { readonly id: string };
  }[],
): ActorOption[] =>
  edges.map(({ node }) => ({ id: node.id, label: actorLabel(node) }));

export default function CreateObjectsPage(props: RouteSectionProps<RouteData>) {
  const data = createPreloadedQuery<InstanceActorListQuery>(
    instanceActorListQuery,
    () => props.data,
  );

  const actors = () => data()?.instance?.actors?.edges;

  const [currentActor, setCurrentActor] = createSignal<ActorOption | null>(
    null,
  );

  const [commitCreateObject, isCreating] =
    createMutation<CreateObjectMutation>(createObjectMutation);
  const [message, setMessage] = createSignal<string>("");

  const submit = (form: HTMLFormElement) => {
    if (isCreating()) return;
    setMessage("");
    const formData = new FormData(form);
    const addressingText = formData.get("addressing");
    let addressing: unknown;
    const nameText = formData.get("name");
    const name = typeof nameText === "string" ? nameText : "";
    try {
      addressing = JSON.parse(
        typeof addressingText === "string" ? addressingText : "{}",
      );
    } catch {
      setMessage("Addressing must be valid JSON.");
      showToast(message(), "fail");
      return;
    }
    const input = v.safeParse(createObjectSchema, {
      actor: (currentActor() ?? actors()?.[0]?.node)?.id,
      name,
      contentHtml: formData.get("content"),
      type: formData.get("type"),
      addressing,
    });
    if (!input.success) {
      setMessage(input.issues.map((issue) => issue.message).join("\n"));
      showToast(message(), "fail");
      return;
    }
    commitCreateObject({
      variables: input.output,
      onCompleted(response, errors) {
        if (errors != null && errors.length > 0) {
          setMessage(errors.map((error) => error.message).join("\n"));
          showToast(message(), "fail");

          return;
        }
        const result = response.createObject;
        if (result.resultType === "Object") {
          form.reset();
          setMessage("Object created successfully.");
          showToast(message(), "success");
        } else {
          setMessage(
            result.resultType === "CreateObjectError"
              ? result.message
              : "Unable to create the object.",
          );
          showToast(message(), "fail");
        }
      },
      onError: (error) => {
        setMessage(error.message);
        showToast(message(), "fail");
      },
    });
  };

  return (
    <Show
      when={actors()}
      fallback={
        <main class={styles.page}>
          <p role="alert">Instance not found.</p>
        </main>
      }
    >
      {(actorList) => (
        <main class={styles.page}>
          <Title>Create Object</Title>
          <section
            class={`${styles.panel} ${objectStyles.panel}`}
            aria-labelledby="create-object-title"
          >
            <header class={styles.header}>
              <h1 id="create-object-title">Create Object</h1>
              <p>Selected Instance: {data()?.instance?.host}</p>
            </header>

            <form
              class={styles.form}
              aria-busy={isCreating()}
              onSubmit={(event) => {
                event.preventDefault();
                submit(event.currentTarget);
              }}
              onReset={() => {
                setCurrentActor(null);
                setMessage("");
              }}
            >
              <fieldset class={objectStyles.fields} disabled={isCreating()}>
                <div class={objectStyles.identity}>
                  <Select<ActorOption>
                    class={styles.field}
                    disabled={isCreating()}
                    value={
                      currentActor() ?? actorOptions(actorList())[0] ?? null
                    }
                    onChange={setCurrentActor}
                    optionValue="id"
                    optionTextValue="label"
                    placeholder="Select Handle"
                    options={actorOptions(actorList())}
                    itemComponent={(itemProps) => (
                      <Select.Item
                        class={objectStyles.option}
                        item={itemProps.item}
                      >
                        <Select.ItemLabel>
                          {itemProps.item.rawValue.label}
                        </Select.ItemLabel>
                        <Select.ItemIndicator aria-hidden="true">
                          ✓
                        </Select.ItemIndicator>
                      </Select.Item>
                    )}
                  >
                    <Select.Label class={objectStyles.label}>
                      Actor
                    </Select.Label>
                    <Select.Trigger
                      class={`${styles.input} ${objectStyles.control} ${objectStyles.trigger}`}
                      type="button"
                    >
                      <Select.Value<ActorOption>>
                        {(state) => state.selectedOption().label}
                      </Select.Value>
                      <Select.Icon aria-hidden="true">▾</Select.Icon>
                    </Select.Trigger>
                    <Select.Portal>
                      <Select.Content class={objectStyles.selectContent}>
                        <Select.Listbox class={objectStyles.listbox} />
                      </Select.Content>
                    </Select.Portal>
                  </Select>

                  <label class={styles.field}>
                    <span class={objectStyles.label}>Type</span>
                    <select
                      class={`${styles.input} ${objectStyles.control}`}
                      name="type"
                    >
                      <option value="Note" selected>
                        Note
                      </option>
                      <option value="Article">Article</option>
                    </select>
                  </label>
                </div>

                <TextField class={styles.field} name="name" defaultValue="">
                  <TextField.Label class={styles.fieldHeading}>
                    Name <span class={styles.fieldStatus}>Optional</span>
                  </TextField.Label>
                  <TextField.Input
                    class={styles.input}
                    placeholder="Object title"
                  />
                </TextField>
                <TextField class={styles.field} name="content" required>
                  <TextField.Label class={styles.fieldHeading}>
                    Content <span class={styles.required}>Required</span>
                  </TextField.Label>
                  <TextField.TextArea
                    class={`${styles.input} ${objectStyles.content}`}
                    rows={8}
                    placeholder="<p>Write your content here.</p>"
                  />
                  <TextField.Description class={styles.hint}>
                    HTML content is stored as entered. This object will not be
                    delivered to remote servers.
                  </TextField.Description>
                </TextField>
                <TextField
                  class={styles.field}
                  name="addressing"
                  defaultValue="{}"
                >
                  <TextField.Label class={styles.fieldHeading}>
                    Addressing <span class={styles.fieldStatus}>JSON</span>
                  </TextField.Label>
                  <TextField.TextArea
                    class={`${styles.input} ${objectStyles.addressing}`}
                    rows={4}
                    spellcheck={false}
                  />
                  <TextField.Description class={styles.hint}>
                    Use to, cc, bto, bcc, or audience with arrays of recipient
                    URLs. Leave {"{}"} for no recipients.
                  </TextField.Description>
                </TextField>
                <Show when={actorList().length === 0}>
                  <p class={styles.hint}>
                    Create an actor in this instance before creating an object.
                  </p>
                </Show>
                <div class={objectStyles.actions}>
                  <button class={objectStyles.reset} type="reset">
                    Reset
                  </button>
                  <button
                    class={styles.button}
                    type="submit"
                    disabled={isCreating() || (actors()?.length ?? 0) === 0}
                  >
                    {isCreating() ? "Creating…" : "Create Object"}
                  </button>
                </div>
              </fieldset>
            </form>
          </section>
        </main>
      )}
    </Show>
  );
}
