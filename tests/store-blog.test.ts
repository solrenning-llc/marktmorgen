/**
 * A store's blog (lib/store-blog.ts; app/api/store/blog). Checked: a post is
 * kept as typed, made safe; only published posts are on the blog, newest
 * first, a page at a time, and a draft never is; one first published keeps
 * its date; a blog holds what it says it holds; a deleted post is gone; the
 * address is the title in words with the id at the end; the words become
 * headings, paragraphs and lists, never markup; the route needs the page
 * permission and keeps the count on the store's record.
 */
import { readFileSync } from "node:fs";
import { MAX_POSTS, POSTS_PER_PAGE, allPosts, cleanPost, deletePost, postBlocks, postIdFrom, postSegment, publishedPosts, publishedTotal, readPost, savePost } from "@/lib/store-blog";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { ROOM } from "./data-room";

let n = 0;
const nextId = () => (n++).toString(16).padStart(10, "0");

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  const S = "stats1";

  part("Unknown counts never authorize a post or invent an empty blog");
  const pipeline=redis.pipeline;
  let visited=0;
  const unknownCounts:[string,()=>unknown][]=[
    ["null",()=>[null]],["string",()=>["0"]],["empty",()=>[""]],["boolean",()=>[false]],
    ["negative",()=>[-1]],["fraction",()=>[0.5]],["unsafe",()=>[9007199254740992]],
    ["missing",()=>[]],["extra",()=>[0,0]],["extra field",()=>Object.assign([0],{extra:true})],
    ["inherited",()=>{const a=new Array(1);Object.setPrototypeOf(a,{0:0});return a;}],
    ["getter",()=>{const a=[0];Object.defineProperty(a,"0",{get(){visited++;return 0;}});return a;}],
    ["proxy",()=>new Proxy([0],{get(t,p,r){if(p!=="then")visited++;return Reflect.get(t,p,r);}})],
  ];
  for(const [label,shape] of unknownCounts){
    let calls=0;
    redis.pipeline=async commands=>{calls++;return commands[0][0]==="HLEN"?shape() as never:pipeline(commands);};
    try{
      let state="threw";
      try{const saved=await savePost("evidence-"+label,null,{title:"Count evidence",body:"Synthetic words.",product:null,draft:true},nextId,ROOM);state=saved.ok?"saved":saved.reason;}catch{}
      is("unknown admission refused: "+label,state,"unknown");
      is("no data reservation or write after unreadable count: "+label,calls,1);
    }finally{redis.pipeline=pipeline;}
    redis.pipeline=async()=>shape() as never;
    try{is("unknown sitemap count: "+label,await publishedTotal(S),null);}finally{redis.pipeline=pipeline;}
  }
  for(const count of [null,"0",false,-1,0.5,9007199254740992]){
    redis.pipeline=async()=>[[],count] as never;
    try{let refused=false;try{await publishedPosts(S,1);}catch{refused=true;}is("unknown page count refuses: "+String(count),refused,true);}finally{redis.pipeline=pipeline;}
  }
  redis.pipeline=async()=>[0];
  try{is("confirmed empty sitemap",await publishedTotal(S),0);}finally{redis.pipeline=pipeline;}
  is("no count getter observed",visited,0);

  part("Unconfirmed mutation never releases room or reports a count");
  const input={title:"Mutation evidence",body:"Synthetic words.",product:null,draft:false};
  for(const count of [null,"1",false]){
    redis.pipeline=async commands=>{
      const reply=await pipeline(commands);
      return commands[0][0]==="HSET"&&String(commands[0][1]).startsWith("nl:blog:")?[reply[0],reply[1],reply[2],count] as never:reply;
    };
    try{const saved=await savePost("mutation-evidence",null,input,nextId,ROOM);is("confirmed save keeps its id with unknown total: "+String(count),saved.ok?[saved.published,typeof saved.post.id]:saved.reason,[null,"string"]);}finally{redis.pipeline=pipeline;}
  }
  const kept=await savePost("delete-evidence",null,input,nextId,ROOM);
  if(!kept.ok)throw Error("synthetic fixture failed");
  let releases=0;
  redis.pipeline=async commands=>{
    if(commands[0][0]==="HDEL"&&String(commands[0][1]).startsWith("nl:blog:"))return [null,null,null,null];
    if(commands.some(c=>c[0]==="EVAL"))releases++;
    return pipeline(commands);
  };
  try{let outcome:unknown;try{outcome=await deletePost("delete-evidence",kept.post.id,ROOM);}catch(error){outcome=error instanceof Error?error.name:"failed";}is("unconfirmed delete has an explicit retry-check outcome",outcome,"BlogWriteUnconfirmed");is("unconfirmed delete never releases data room",releases,0);}finally{redis.pipeline=pipeline;}
  is("unconfirmed deletion leaves fixture content intact",(await readPost("delete-evidence",kept.post.id))?.body,input.body);

  part("What is kept");
  const clean = cleanPost({ title: "  Bread   on Sundays  ", body: "Line one\r\n\r\n\r\n- a point", product: "../evil", draft: "yes" });
  is("a title on one line, the words tidied, no product that is not an id, a draft only when said", clean, { title: "Bread on Sundays", body: "Line one\n\n- a point", product: null, draft: false });
  const first = await savePost(S, null, { title: "Rye for beginners", body: "## Why rye\nIt keeps.\n\n- flour\n- water", product: "knife00001", draft: false }, nextId, ROOM, 1_000);
  is("published, with its date", first.ok ? [first.post.publishedAt, first.published] : null, [1_000, 1]);
  const draft = await savePost(S, null, { title: "Not yet", body: "Soon.", product: null, draft: true }, nextId, ROOM, 2_000);
  is("a draft is not counted as published", draft.ok ? [draft.post.publishedAt, draft.published] : null, [0, 1]);
  is("a post needs a title and words", [(await savePost(S, null, { title: "", body: "x", product: null, draft: false }, nextId, ROOM)).ok, (await savePost(S, null, { title: "x", body: "", product: null, draft: false }, nextId, ROOM)).ok], [false, false]);

  part("What the blog shows");
  for (let i = 0; i < POSTS_PER_PAGE + 1; i += 1) await savePost(S, null, { title: `Post ${i}`, body: "Words.", product: null, draft: false }, nextId, ROOM, 3_000 + i);
  const page1 = await publishedPosts(S, 1);
  is("newest first, a page at a time, drafts never", [page1.posts[0].title, page1.posts.length, page1.total, page1.posts.some((p) => p.draft)], [`Post ${POSTS_PER_PAGE}`, POSTS_PER_PAGE, POSTS_PER_PAGE + 2, false]);
  is("and the rest on the next page", (await publishedPosts(S, 2)).posts.map((p) => p.title), ["Post 0", "Rye for beginners"]);
  const id = first.ok ? first.post.id : "";
  const edited = await savePost(S, id, { title: "Rye, for beginners", body: "Edited.", product: null, draft: false }, nextId, ROOM, 9_000);
  is("an edit keeps the date it was first published", edited.ok ? [edited.post.publishedAt, edited.post.updatedAt] : null, [1_000, 9_000]);
  const back = await savePost(S, id, { title: "Rye, for beginners", body: "Edited.", product: null, draft: true }, nextId, ROOM, 9_500);
  is("made a draft again, it leaves the blog", [back.ok ? back.published : null, (await readPost(S, id))?.draft], [POSTS_PER_PAGE + 1, true]);
  is("the studio sees every post, drafts too", (await allPosts(S)).length, POSTS_PER_PAGE + 3);

  part("Gone, and full");
  is("a deleted post is gone", [await deletePost(S, id, ROOM), await readPost(S, id)], [POSTS_PER_PAGE + 1, null]);
  for (let i = (await allPosts(S)).length; i < MAX_POSTS; i += 1) await savePost(S, null, { title: `Filler ${i}`, body: "x", product: null, draft: true }, nextId, ROOM);
  const over = await savePost(S, null, { title: "One too many", body: "x", product: null, draft: false }, nextId, ROOM);
  is(`a blog holds ${MAX_POSTS} posts`, over.ok ? null : over.reason, "full");

  part("Addresses and words");
  is("the title in words, the id at the end", postSegment({ id: "00000000ab", title: "Rye, for Beginners!" }), "rye-for-beginners-00000000ab");
  is("read back from any title, or the id alone", [postIdFrom("old-words-00000000ab"), postIdFrom("00000000ab"), postIdFrom("nope"), postIdFrom("x00000000ab")], ["00000000ab", "00000000ab", null, null]);
  const blocks = postBlocks("## Why rye\nIt keeps <script>.\n\n- flour\n- https://example.com/rye.");
  is("headings, paragraphs and lists, nothing read as markup", [blocks[0], blocks[1].kind, blocks[2].kind, JSON.stringify(blocks).includes("<script>")], [{ kind: "heading", text: "Why rye" }, "paragraph", "list", true]);
  is("an address becomes a link, the full stop left out", blocks[2].kind === "list" ? blocks[2].items[1].find((p) => p.href)?.href : null, "https://example.com/rye");

  part("The route");
  const route = readFileSync("app/api/store/blog/route.ts", "utf8");
  is("needs the page permission, and keeps the count on the store", [route.includes('guardStoreWrite(request, "page"'), (route.match(/setPostCount\(/g) ?? []).length], [true, 2]);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
