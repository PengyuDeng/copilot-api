import { Hono } from "hono"

import { forwardError } from "~/lib/error"
import { getHeaderSessionId } from "~/lib/session"
import {
  createEmbeddings,
  type EmbeddingRequest,
} from "~/services/copilot/create-embeddings"

export const embeddingRoutes = new Hono()

embeddingRoutes.post("/", async (c) => {
  try {
    const paylod = await c.req.json<EmbeddingRequest>()
    const response = await createEmbeddings(paylod, {
      sessionId: getHeaderSessionId(c),
    })

    return c.json(response)
  } catch (error) {
    return await forwardError(c, error)
  }
})
