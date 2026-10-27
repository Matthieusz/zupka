# Build a reusable, self-hosted headless CMS

This repository will provide a private admin interface and content API, separate from the public sites that consume its content. informati.dev is an intended consumer, not a product-specific constraint: others must be able to use the CMS for their own portfolios.

Each person deploys their own CMS, with one owner managing its content. We are not building a shared hosted platform, multi-tenant accounts, or multi-user editorial workflows. This keeps deployment and content ownership independent without introducing platform administration.

Posts and Projects are built-in content types, but the CMS is not limited to them: owners can add custom fields to content types and define custom content types.
