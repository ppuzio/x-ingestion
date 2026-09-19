/** Renders the native Obsidian Base used to browse generated captures and human reviews. */
export function renderLibraryBase(): string {
  return `filters:
  or:
    - and:
        - 'file.inFolder("Sources")'
        - 'type == "x-capture"'
    - and:
        - 'file.inFolder("Reviews")'
        - 'type == "x-review"'
properties:
  note.title:
    displayName: Title
  note.post_id:
    displayName: Post ID
  note.topics:
    displayName: Topics
  note.author:
    displayName: Author
  note.captured:
    displayName: Captured
  note.relevance_status:
    displayName: Relevance
  note.source_gaps:
    displayName: Source gaps
  note.review:
    displayName: Review
  note.source:
    displayName: Source
  note.status:
    displayName: Review status
views:
  - type: table
    name: Captures
    filters: 'type == "x-capture"'
    order:
      - file.name
      - note.title
      - note.topics
      - note.author
      - note.captured
      - note.relevance_status
      - note.source_gaps
      - note.review
  - type: table
    name: Topics
    filters:
      and:
        - 'type == "x-capture"'
        - 'file.hasProperty("topics")'
    groupBy:
      property: note.topics
      direction: ASC
    order:
      - file.name
      - note.title
      - note.topics
      - note.author
      - note.review
  - type: table
    name: Source gaps
    filters:
      and:
        - 'type == "x-capture"'
        - 'file.hasProperty("source_gaps")'
    order:
      - file.name
      - note.title
      - note.source_gaps
      - note.author
      - note.review
  - type: table
    name: Relevance
    filters:
      and:
        - 'type == "x-capture"'
        - 'file.hasProperty("relevance_status")'
    groupBy:
      property: note.relevance_status
      direction: ASC
    order:
      - file.name
      - note.title
      - note.relevance_status
      - note.topics
      - note.review
  - type: table
    name: Reviews
    filters: 'type == "x-review"'
    order:
      - file.name
      - note.title
      - note.status
      - note.source
      - note.post_id
  - type: table
    name: Unread reviews
    filters:
      and:
        - 'type == "x-review"'
        - 'status == "unread"'
    order:
      - file.name
      - note.title
      - note.status
      - note.source
  - type: table
    name: Review status
    filters: 'type == "x-review"'
    groupBy:
      property: note.status
      direction: ASC
    order:
      - file.name
      - note.title
      - note.status
      - note.source
`;
}
