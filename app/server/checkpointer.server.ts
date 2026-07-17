import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";

import { getDatabasePath } from "./sqlite.server";

export const checkpointer = SqliteSaver.fromConnString(getDatabasePath());
