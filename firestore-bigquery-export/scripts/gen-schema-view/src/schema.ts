/*
 * Copyright 2019 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import * as bigquery from "@google-cloud/bigquery";
import * as logs from "./logs";
import { RawChangelogViewSchema } from "@firebaseextensions/firestore-bigquery-change-tracker";
import { latestConsistentSnapshotSchemaView } from "./snapshot";
import * as sqlFormatter from "sql-formatter";
import {
  udfs,
  firestoreArray,
  firestoreBoolean,
  firestoreNumber,
  firestoreTimestamp,
  firestoreGeopoint,
} from "./udf";

export type FirestoreFieldType =
  | "boolean"
  | "geopoint"
  | "number"
  | "map"
  | "array"
  | "null"
  | "string"
  | "timestamp"
  | "reference";

type BigQueryFieldType =
  | "BOOLEAN"
  | "GEOGRAPHY"
  | "NUMERIC"
  | "NULL"
  | "STRING"
  | "TIMESTAMP";

export type FirestoreField = {
  fields?: FirestoreField[];
  name: string;
  repeated?: boolean;
  description?: string;
  type: FirestoreFieldType;
};

export type FirestoreSchema = {
  idField?: string;
  fields: FirestoreField[];
  timestampField?: string;
};

/*
 * A static mapping from Firestore types to BigQuery column types. We generate
 * a BigQuery schema in the same pass that generates the view generation query.
 */
const firestoreToBigQueryFieldType: {
  [f in FirestoreFieldType]: BigQueryFieldType
} = {
  boolean: "BOOLEAN",
  geopoint: "GEOGRAPHY",
  number: "NUMERIC",
  null: "STRING",
  string: "STRING",
  timestamp: "TIMESTAMP",
  reference: "STRING",
  array: null /* mode: REPEATED type: STRING */,
  map: null,
};

/**
 * A factory class for constructing schema views over raw json time-series
 * change logs.
 */
export class FirestoreBigQuerySchemaViewFactory {
  bq: bigquery.BigQuery;

  constructor() {
    this.bq = new bigquery.BigQuery();
  }

  /**
   * Given the name of the raw changelog in BigQuery, constructs a changelog
   * with schema fields extracted into their own BigQuery-typed columns. Also
   * creates a view consisting of only the latest events for all live documents
   * with the schema type applied.
   *
   * This method will not create views if they already exist in BigQuery.
   */
  async initializeSchemaViewResources(
    datasetId: string,
    tableNamePrefix: string,
    schemaName: string,
    firestoreSchema: FirestoreSchema
  ): Promise<bigquery.Table> {
    const rawChangeLogTableName = changeLog(raw(tableNamePrefix));
    const latestRawViewName = latest(raw(tableNamePrefix));
    const changeLogSchemaViewName = changeLog(
      schema(tableNamePrefix, schemaName)
    );
    const latestSchemaViewName = latest(schema(tableNamePrefix, schemaName));
    const dataset = this.bq.dataset(datasetId);

    const udfNames = Object.keys(udfs);

    for (let i = 0; i < udfNames.length; i++) {
      const functionName = udfNames[i];
      const udf = udfs[functionName](datasetId);
      await this.bq.query({
        query: udf.query,
      });
    }

    let view = dataset.table(changeLogSchemaViewName);
    const [viewExists] = await view.exists();

    let latestView = dataset.table(latestSchemaViewName);
    const [latestViewExists] = await latestView.exists();

    let result = userSchemaView(
      datasetId,
      rawChangeLogTableName,
      firestoreSchema
    );
    let bigQueryFields = result.fields;
    const options = {
      friendlyName: changeLogSchemaViewName,
      view: result.viewInfo,
    };
    if (!viewExists) {
      logs.bigQuerySchemaViewCreating(
        changeLogSchemaViewName,
        firestoreSchema,
        result.viewInfo.query
      );
      await view.create(options);
      logs.bigQuerySchemaViewCreated(changeLogSchemaViewName);
    }

    await view.setMetadata({
      schema: decorateSchemaWithChangelogFields({
        fields: bigQueryFields,
      }),
    });

    result = latestConsistentSnapshotSchemaView(
      datasetId,
      latestRawViewName,
      firestoreSchema
    );
    bigQueryFields = result.fields;
    const latestOptions = {
      fiendlyName: latestSchemaViewName,
      view: result.viewInfo,
    };
    if (!latestViewExists) {
      logs.bigQuerySchemaViewCreating(
        latestSchemaViewName,
        firestoreSchema,
        result.viewInfo.query
      );
      await latestView.create(latestOptions);
      logs.bigQueryViewCreated(latestSchemaViewName);
    }
    await latestView.setMetadata({
      schema: decorateSchemaWithChangelogFields({
        fields: bigQueryFields,
      }),
    });

    return view;
  }
}

/**
 * Given a BigQuery schema returned from either `userSchemaView` or
 * `latestConsistentSnapshotSchemaView`, inherit the appropriate
 * fields from the raw changelog schema and return the combined schemas.
 */
function decorateSchemaWithChangelogFields(schema: any): any {
  let decorated: any = { fields: schema.fields };
  const changelogSchemaFields: any[] = RawChangelogViewSchema.fields;
  for (let i = 0; i < changelogSchemaFields.length; i++) {
    if (
      changelogSchemaFields[i].name === "event_id" ||
      changelogSchemaFields[i].name === "data"
    ) {
      continue;
    }
    decorated.fields.push(changelogSchemaFields[i]);
  }
  return decorated;
}

/**
 * A wrapper around `buildSchemaView`.
 */
export function userSchemaView(
  datasetId: string,
  tableName: string,
  schema: FirestoreSchema
): any {
  let result = buildSchemaViewQuery(datasetId, tableName, schema);
  return {
    viewInfo: {
      query: result.query,
      useLegacySql: false,
    },
    fields: result.fields,
  };
}

/**
 * Constructs a query for building a view over a raw changelog table name.
 */
export const buildSchemaViewQuery = (
  datasetId: string,
  rawTableName: string,
  schema: FirestoreSchema
): any => {
  const result = processFirestoreSchema(datasetId, "data", schema);
  const [fieldExtractors, fieldArrays] = result.queryInfo;
  const bigQueryFields = result.fields;
  const fieldValueSelectorClauses = Object.values(fieldExtractors).join(", ");
  const schemaHasArrays = fieldArrays.length > 0;
  let query = `
    SELECT
      document_name,
      timestamp,
      operation${fieldValueSelectorClauses.length > 0 ? `,` : ``}
      ${fieldValueSelectorClauses}
      FROM
        \`${process.env.PROJECT_ID}.${datasetId}.${rawTableName}\`
  `;
  if (schemaHasArrays) {
    /**
     * If the schema we are generating has arrays, we perform a CROSS JOIN with
     * the result of UNNESTing each array so that each document ends up with N
     * rows, one for each of N members of it's contained array. Each of these
     * rows contains an additional index column and a corresponding member
     * column which can be used to investigate the historical values of various
     * positions inside an array. If a document has multiple arrays, the number
     * of additional rows added per document will be the product of the lengths
     * of all the arrays.
     */
    query = `${subSelectQuery(query)} ${rawTableName} ${fieldArrays
      .map(
        (arrayFieldName) =>
          `CROSS JOIN UNNEST(${rawTableName}.${arrayFieldName})
       AS ${arrayFieldName}_member
       WITH OFFSET ${arrayFieldName}_index`
      )
      .join(" ")}`;

    for (const arrayFieldName of fieldArrays) {
      bigQueryFields.push({
        name: `${arrayFieldName}_index`,
        type: "INTEGER",
        mode: "NULLABLE",
        description: `Index of the corresponding ${arrayFieldName}_member cell in ${arrayFieldName}.`,
      });
      bigQueryFields.push({
        name: `${arrayFieldName}_member`,
        type: "STRING",
        mode: "NULLABLE",
        description: `String representation of the member of ${arrayFieldName}[${arrayFieldName}_index].`,
      });
    }
  }
  query = sqlFormatter.format(query);
  return {
    query: query,
    fields: bigQueryFields,
  };
};

/**
 * Given a Cloud Firestore schema which may contain values for any type present
 * in the Firestore document proto, return a list of clauses that may be
 * used to extract schema values from a JSON string and convert them into
 * the corresponding BigQuery type.
 * @param datasetId the BigQuery dataset
 * @param dataFieldName the name of the columns storing raw JSON data
 * @param schema the Firestore Schema used to create selectors
 * @param transformer an optional BigQuery function to apply to each
 * select clause found during the search.
 */
export function processFirestoreSchema(
  datasetId: string,
  dataFieldName: string,
  schema: FirestoreSchema,
  transformer?: (selector: string) => string
): any {
  if (!transformer) {
    transformer = (selector: string) => selector;
  }
  let extractors: { [fieldName: string]: string } = {};
  let arrays: string[] = [];
  let geopoints: string[] = [];
  let bigQueryFields: { [property: string]: string }[] = [];
  processFirestoreSchemaHelper(
    datasetId,
    dataFieldName,
    /*prefix=*/ [],
    schema,
    arrays,
    geopoints,
    extractors,
    transformer,
    bigQueryFields
  );
  return {
    queryInfo: [extractors, arrays, geopoints],
    fields: bigQueryFields,
  };
}

/**
 * Searches the user-defined schema and generates a listing of all SELECT
 * clauses which are necessary to generate a BigQuery-typed view over the
 * raw data contained in `dataFieldName`. We keep track of arrays and
 * geopoints separately because they require handling in a context that
 * this function doesn't have access to:
 *
 * - Arrays must be unnested in the non-snapshot query (buildSchemaView) and
 *   filtered out in the snapshot query (buildLatestSnapshotViewQuery) because
 *   they are not groupable
 * - Geopoints must be filtered out in the snapshot query
 *   (buildLatestSnapshotViewQuery) because they are not groupable
 */
function processFirestoreSchemaHelper(
  datasetId: string,
  dataFieldName: string,
  prefix: string[],
  schema: FirestoreSchema,
  arrays: string[],
  geopoints: string[],
  extractors: { [fieldName: string]: string },
  transformer: (selector: string) => string,
  bigQueryFields: { [property: string]: string }[]
) {
  const { fields, idField } = schema;
  return fields.map((field) => {
    if (field.type === "map") {
      const subschema: FirestoreSchema = { fields: field.fields };
      processFirestoreSchemaHelper(
        datasetId,
        dataFieldName,
        prefix.concat(field.name),
        subschema,
        arrays,
        geopoints,
        extractors,
        transformer,
        bigQueryFields
      );
      return;
    }
    const fieldNameToSelector = processLeafField(
      datasetId,
      "data",
      prefix,
      field,
      transformer,
      bigQueryFields
    );
    for (let fieldName in fieldNameToSelector) {
      extractors[fieldName] = fieldNameToSelector[fieldName];
    }
    // For "latest" data views, certain types of fields cannot be used in
    // "GROUP BY" clauses. We keep track of them so they can be explicitly
    // transformed into groupable types later.
    if (field.type === "array") {
      arrays.push(qualifyFieldName(prefix, field.name));
    }
    if (field.type === "geopoint") {
      geopoints.push(qualifyFieldName(prefix, field.name));
    }
  });
}

/**
 * Once we have reached the field in the JSON tree, we must determine what type
 * it is in the schema and then perform any conversions needed to coerce it into
 * the BigQuery type.
 */
const processLeafField = (
  datasetId: string,
  dataFieldName: string,
  prefix: string[],
  field: FirestoreField,
  transformer: (selector: string) => string,
  bigQueryFields: { [property: string]: string }[]
) => {
  let extractPrefix = `${prefix.join(".")}`;
  let fieldNameToSelector = {};
  let selector;
  switch (field.type) {
    case "null":
      selector = transformer(`NULL`);
      break;
    case "string":
    case "reference":
      selector = jsonExtract(
        dataFieldName,
        extractPrefix,
        field,
        ``,
        transformer
      );
      break;
    case "array":
      selector = firestoreArray(
        datasetId,
        jsonExtract(dataFieldName, extractPrefix, field, ``, transformer)
      );
      break;
    case "boolean":
      selector = firestoreBoolean(
        datasetId,
        jsonExtract(dataFieldName, extractPrefix, field, ``, transformer)
      );
      break;
    case "number":
      selector = firestoreNumber(
        datasetId,
        jsonExtract(dataFieldName, extractPrefix, field, ``, transformer)
      );
      break;
    case "timestamp":
      selector = firestoreTimestamp(
        datasetId,
        jsonExtract(dataFieldName, extractPrefix, field, ``, transformer)
      );
      break;
    case "geopoint":
      const latitude = jsonExtract(
        dataFieldName,
        extractPrefix,
        field,
        `._latitude`,
        transformer
      );
      const longitude = jsonExtract(
        dataFieldName,
        extractPrefix,
        field,
        `._longitude`,
        transformer
      );
      /*
       * We return directly from this branch because it's the only one that
       * generates multiple selector clauses.
       */
      fieldNameToSelector[
        qualifyFieldName(prefix, field.name)
      ] = `${firestoreGeopoint(
        datasetId,
        jsonExtract(dataFieldName, extractPrefix, field, ``, transformer)
      )} AS ${prefix.concat(field.name).join("_")}`;

      bigQueryFields.push({
        name: qualifyFieldName(prefix, field.name),
        mode: "NULLABLE",
        type: firestoreToBigQueryFieldType[field.type],
        description: field.description,
      });

      fieldNameToSelector[
        qualifyFieldName(prefix, `${field.name}_latitude`)
      ] = `SAFE_CAST(${latitude} AS NUMERIC) AS ${qualifyFieldName(
        prefix,
        `${field.name}_latitude`
      )}`;

      bigQueryFields.push({
        name: qualifyFieldName(prefix, `${field.name}_latitude`),
        mode: "NULLABLE",
        type: "NUMERIC",
        description: `Numeric latitude component of ${field.name}.`,
      });

      fieldNameToSelector[
        qualifyFieldName(prefix, `${field.name}_longitude`)
      ] = `SAFE_CAST(${longitude} AS NUMERIC) AS ${qualifyFieldName(
        prefix,
        `${field.name}_longitude`
      )}`;

      bigQueryFields.push({
        name: qualifyFieldName(prefix, `${field.name}_longitude`),
        mode: "NULLABLE",
        type: "NUMERIC",
        description: `Numeric longitude component of ${field.name}.`,
      });
      return fieldNameToSelector;
  }
  fieldNameToSelector[
    qualifyFieldName(prefix, field.name)
  ] = `${selector} AS ${qualifyFieldName(prefix, field.name)}`;
  if (field.type === "array") {
    bigQueryFields.push({
      name: qualifyFieldName(prefix, field.name),
      mode: "REPEATED",
      type: "STRING",
      description: field.description,
    });
  } else {
    bigQueryFields.push({
      name: qualifyFieldName(prefix, field.name),
      mode: "NULLABLE",
      type: firestoreToBigQueryFieldType[field.type],
      description: field.description,
    });
  }
  return fieldNameToSelector;
};

/**
 * Extract a field from a raw JSON string that lives in the column
 * `dataFieldName`. The result of this function is a clause which can be used in
 * the argument of a SELECT query to create a corresponding BigQuery-typed
 * column in the result set.
 *
 * @param dataFieldName the source column containing raw JSON
 * @param prefix the path we need to follow from the root of the JSON to arrive
 * at the named field
 * @param field the field we are extracting
 * @param subselector the path we want to follow within the named field. As an
 * example, this is useful when extracting latitude and longitude from a
 * serialized geopoint field.
 * @param transformer any transformation we want to apply to the result of
 * JSON_EXTRACT. This is typically a BigQuery CAST, or an UNNEST (in the case
 * where the result is an ARRAY).
 */
const jsonExtract = (
  dataFieldName: string,
  prefix: string,
  field: FirestoreField,
  subselector: string = "",
  transformer: (selector: string) => string
) => {
  return transformer(
    `JSON_EXTRACT(${dataFieldName}, \'\$.${
      prefix.length > 0 ? `${prefix}.` : ``
    }${field.name}${subselector}\')`
  );
};

/**
 * Given a select query, $QUERY, return a query that wraps the result in an
 * outer-select, optionally filtering some fields out using the SQL `EXCEPT`
 * clause. This is used when generating the latest view of a schema change-log
 * in order to omit BigQuery un-groupable columns.
 *
 * SELECT *, EXCEPT (cola, colb, ...) FROM (SELECT ...);
 *
 * @param query a SELECT query
 * @param filter an array of field names to filter out from `query`
 */
export function subSelectQuery(query: string, filter?: string[]): string {
  return `SELECT * ${
    filter && filter.length > 0 ? `EXCEPT (${filter.join(", ")})` : ``
  } FROM (${query})`;
}

function qualifyFieldName(prefix: string[], name: string): string {
  // TVirl
  // "Fields must contain only letters, numbers, and underscores,
  //  start with a letter or underscore, and be at most 128 characters long."
  const notAlphaDigitUnderscore = /([^a-zA-Z0-9_])/;
  name = name.replace(notAlphaDigitUnderscore, '_');
  // TODO: first char. length limit

  return prefix.concat(name).join("_");
}

export function latest(tableName: string): string {
  return `${tableName}_latest`;
}
export function schema(tableName: string, schemaName: string): string {
  return `${tableName}_schema_${schemaName}`;
}
export function raw(tableName: string): string {
  return `${tableName}_raw`;
}
export function changeLog(tableName: string): string {
  return `${tableName}_changelog`;
}
