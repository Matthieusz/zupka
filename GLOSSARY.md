# Portfolio Content

Language for a reusable CMS that manages content for independently built portfolio sites.

## Language

**Owner**:
The sole person who manages a portfolio's content through the CMS.
_Avoid_: Team member, collaborator

**Content type**:
A named category of portfolio content with a defined set of fields. Posts and Projects are built-in content types; the owner can add custom content types.
_Avoid_: Collection, model

**Custom field**:
An owner-defined attribute added to a content type, including a built-in Post or Project.
_Avoid_: Metadata, extra property

**Entry**:
An individual item of a content type, such as a post or project.
_Avoid_: Document, record

**Post**:
An entry for written portfolio content, optionally described by a publication date and tags.
_Avoid_: Article, blog entry

**Project**:
An entry presenting a piece of work, optionally described by technologies and links to its live site and repository.
_Avoid_: Case study, work item

**Slug**:
An entry's human-readable identifier, unique within its content type. It becomes permanent after the entry's first publication.
_Avoid_: Permalink, path

**Draft**:
The working version of an entry, including changes not yet published. An entry can have both a draft and a published version.
_Avoid_: Pending, unpublished release

**Published version**:
The version of an entry the owner has explicitly made available to the public. It remains unchanged when the draft is edited or saved.
_Avoid_: Approved content, released content
