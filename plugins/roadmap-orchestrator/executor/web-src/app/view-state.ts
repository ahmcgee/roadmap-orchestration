import { createContext, useContext, useEffect, useState, useSyncExternalStore } from 'react';
import { ViewStore } from './view-store.ts';
export const Views=createContext<ViewStore|null>(null);
export function useView(path:string|null) {
  const store=useContext(Views);
  useSyncExternalStore(store?.subscribe??(()=>()=>{}),store?.snapshot??(()=>0));
  const version=path?store?.keyVersion(path):null;
  const e=path?store?.entry(path):null;
  useEffect(()=>{if(store&&path)void store.load(path);},[store,path,version,store?.generation]);
  useEffect(()=>{if(!store||!path)return;store.active.set(path,(store.active.get(path)??0)+1);return()=>{const n=(store.active.get(path)??1)-1;if(n)store.active.set(path,n);else{store.active.delete(path);store.abort(path);}};},[store,path]);
  return {data:e?.value?.data??null,envelope:e?.value??null,error:e?.error??'',loading:e?.loading??false,retry:()=>{if(store&&path)void store.load(path,true);}};
}
export function useSelectedDetail(_arc:string,path:string|null){return useView(path);}
export function useRouteState<T>(key:string,initial:T):[T,(next:T)=>void] {
  const store=useContext(Views),[value,setValue]=useState<T>(()=>(store?.ui.get(key) as T|undefined)??initial);
  return [value,next=>{store?.ui.set(key,next);setValue(next);}];
}
