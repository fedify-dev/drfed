/**
 * @generated SignedSource<<8f5be4a4f7eed407137091cb6a5ad784>>
 * @lightSyntaxTransform
 */

/* tslint:disable */
/* eslint-disable */
// @ts-nocheck

import { ConcreteRequest } from 'relay-runtime';
export type HomeViewerQuery$variables = Record<PropertyKey, never>;
export type HomeViewerQuery$data = {
  readonly viewer: {
    readonly admin: boolean;
    readonly name: string;
  } | null | undefined;
};
export type HomeViewerQuery = {
  response: HomeViewerQuery$data;
  variables: HomeViewerQuery$variables;
};

const node: ConcreteRequest = (function(){
var v0 = {
  "alias": null,
  "args": null,
  "kind": "ScalarField",
  "name": "name",
  "storageKey": null
},
v1 = {
  "alias": null,
  "args": null,
  "kind": "ScalarField",
  "name": "admin",
  "storageKey": null
};
return {
  "fragment": {
    "argumentDefinitions": [],
    "kind": "Fragment",
    "metadata": null,
    "name": "HomeViewerQuery",
    "selections": [
      {
        "alias": null,
        "args": null,
        "concreteType": "Account",
        "kind": "LinkedField",
        "name": "viewer",
        "plural": false,
        "selections": [
          (v0/*:: as any*/),
          (v1/*:: as any*/)
        ],
        "storageKey": null
      }
    ],
    "type": "Query",
    "abstractKey": null
  },
  "kind": "Request",
  "operation": {
    "argumentDefinitions": [],
    "kind": "Operation",
    "name": "HomeViewerQuery",
    "selections": [
      {
        "alias": null,
        "args": null,
        "concreteType": "Account",
        "kind": "LinkedField",
        "name": "viewer",
        "plural": false,
        "selections": [
          (v0/*:: as any*/),
          (v1/*:: as any*/),
          {
            "alias": null,
            "args": null,
            "kind": "ScalarField",
            "name": "id",
            "storageKey": null
          }
        ],
        "storageKey": null
      }
    ]
  },
  "params": {
    "cacheID": "6be84a829bea30a1417d764dcba673aa",
    "id": null,
    "metadata": {},
    "name": "HomeViewerQuery",
    "operationKind": "query",
    "text": "query HomeViewerQuery {\n  viewer {\n    name\n    admin\n    id\n  }\n}\n"
  }
};
})();

(node as any).hash = "4c7555c81dde8b7bc2ca6f923515b13d";

export default node;
