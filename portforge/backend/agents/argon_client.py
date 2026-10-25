from __future__ import annotations

import asyncio
import os
from dataclasses import dataclass
from typing import TypeVar, Type

from pydantic import BaseModel

T = TypeVar("T", bound=BaseModel)


@dataclass
class ArgonResult:
    value: BaseModel | None
    mode: str
    error: str | None = None
    token_usage: dict | None = None


class ArgonClient:
    """LangChain wrapper for validated Gemini Argon structured output.

    The improvement loop only calls this adapter at meaningful agent decision
    points. The simulator itself remains deterministic and LLM-independent.
    """

    # Candidate benchmarks run many Operator conversations at once; cap in-flight provider requests.
    MAX_CONCURRENT_CALLS = 6

    def __init__(self):
        self._slots: asyncio.Semaphore | None = None
        self.model = os.getenv("ARGON_MODEL", "gemini-4-argon")
        self.api_key = os.getenv("GEMINI_API_KEY")
        self.mode = "argon" if self.api_key else "mock"
        self.calls_started = 0
        self.calls_completed = 0

    async def structured(self, system: str, prompt: str, schema: Type[T], retries: int = 2) -> ArgonResult:
        if not self.api_key:
            return ArgonResult(None, "mock", "GEMINI_API_KEY is not configured")
        self.calls_started += 1
        try:
            from langchain_core.prompts import ChatPromptTemplate
            from langchain_google_genai import ChatGoogleGenerativeAI
        except ImportError as exc:
            return ArgonResult(None, "mock", f"LangChain Google integration unavailable: {exc}")

        llm = ChatGoogleGenerativeAI(
            model=self.model,
            api_key=self.api_key,
            temperature=0.2,
            timeout=40,
            max_retries=retries,
        )
        prompt_template = ChatPromptTemplate.from_messages([
            ("system", system),
            ("human", "{agent_input}"),
        ])
        # include_raw preserves LangChain/provider metadata for usage reporting
        # while still enforcing the supplied Pydantic schema.
        chain = prompt_template | llm.with_structured_output(schema, include_raw=True)

        try:
            if self._slots is None:
                self._slots = asyncio.Semaphore(self.MAX_CONCURRENT_CALLS)
            async with self._slots:
                response = await chain.ainvoke({"agent_input": prompt})
            parsed = response.get("parsed")
            parsing_error = response.get("parsing_error")
            if parsed is None:
                return ArgonResult(None, "mock", f"Argon structured-output error: {parsing_error}")
            raw = response.get("raw")
            usage = getattr(raw, "usage_metadata", None) if raw else None
            self.calls_completed += 1
            return ArgonResult(parsed, "argon", token_usage=usage)
        except Exception as exc:  # remote errors are surfaced, never silently represented as Argon output
            self.calls_completed += 1
            return ArgonResult(None, "mock", str(exc))
