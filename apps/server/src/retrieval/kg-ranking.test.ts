import {expect,it} from 'vitest';
import {referenceView} from '../../../../tests/helpers/retrieval.js';
import {localRelations,globalEntities} from './algorithms.js';
it('keeps entity recall order, sorts local edges by endpoint degrees then weight, including self loops',()=>{
 const {view}=referenceView();const local=['C','A','B'].map(n=>view.node(n)!);
 expect(local.map(n=>n.name)).toEqual(['C','A','B']);
 expect(localRelations(view,local).map(e=>[e.sourceId,e.targetId])).toEqual([['B','D'],['A','B'],['A','C']]);
});
it('global edge recall keeps vector order and emits endpoints once in first-seen order',()=>{
 const {view}=referenceView();const edges=[view.edge('D','D')!,view.edge('A','C')!,view.edge('A','B')!];
 expect(globalEntities(view,edges).map(n=>n.name)).toEqual(['D','A','C','B']);
});
it('canonicalizes endpoint order by entity names rather than the lexical order of persisted hash IDs',()=>{
 const {view,graph}=referenceView();
 graph.setNode({id:'z-id',name:'Alpha',type:'Concept',description:'Alpha',sourceChunkIds:['z']});
 graph.setNode({id:'a-id',name:'Beta',type:'Concept',description:'Beta',sourceChunkIds:['a']});
 graph.setEdge({sourceId:'z-id',targetId:'a-id',description:'AB',keywords:[],weight:1,sourceChunkIds:['z']});
 expect(globalEntities(view,[view.edge('a-id','z-id')!]).map(n=>n.name)).toEqual(['Alpha','Beta']);
});
