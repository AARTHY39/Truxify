import torch
import torch.nn as nn
import torch.nn.functional as F
import numpy as np
from typing import Dict, List, Tuple, Any, Optional
import random
import logging
from collections import OrderedDict
import itertools
from copy import deepcopy
from numbers import Integral
import math

logger = logging.getLogger(__name__)

def _snapshot_architecture(architecture, space=None):
    """Own aligned genotype data before it crosses a search/model boundary."""
    if not isinstance(architecture, dict):
        raise ValueError("architecture must be a dictionary")
    result = deepcopy(architecture)
    fields = ('layers', 'filters', 'activations')
    if any(not isinstance(result.get(key), (list, tuple)) for key in fields):
        raise ValueError("architecture requires aligned layer/filter/activation lists")
    for key in fields:
        result[key] = list(result[key])
    size = len(result['layers'])
    if not size or any(len(result[key]) != size for key in fields):
        raise ValueError("architecture fields must have equal nonzero lengths")
    operations = space.operations if space else NASSearchSpace().operations
    activations = space.activation_functions if space else NASSearchSpace().activation_functions
    if any(op not in operations for op in result['layers']):
        raise ValueError("unknown architecture operation")
    if any(act not in activations for act in result['activations']):
        raise ValueError("unknown architecture activation")
    if any(isinstance(value, bool) or not isinstance(value, Integral) or value <= 0
           for value in result['filters']):
        raise ValueError("filters must be positive integers")
    if space:
        if not space.num_layers_range[0] <= size <= space.num_layers_range[1]:
            raise ValueError("architecture exceeds configured layer range")
        if any(not space.num_filters_range[0] <= value <= space.num_filters_range[1]
               or value % 8 for value in result['filters']):
            raise ValueError("filters must be in the configured range and divisible by eight")
    return result


def _positive_budget(value, name):
    if isinstance(value, bool) or not isinstance(value, Integral) or value <= 0:
        raise ValueError(f"{name} must be a positive integer")
    return int(value)


class NASSearchSpace:
    """Search space for Neural Architecture Search"""
    
    def __init__(self):
        self.operations = [
            'conv3x3', 'conv5x5', 'conv7x7',
            'maxpool3x3', 'avgpool3x3',
            'identity', 'zero'
        ]
        self.num_layers_range = (3, 10)
        self.num_filters_range = (32, 256)
        self.activation_functions = ['relu', 'tanh', 'sigmoid', 'swish']
        
        logger.info("✅ NAS Search Space initialized")
    
    def sample_random_architecture(self) -> Dict:
        """Sample random architecture from search space"""
        num_layers = random.randint(*self.num_layers_range)
        architecture = {
            'layers': [],
            'filters': [],
            'activations': []
        }
        
        for i in range(num_layers):
            # Sample operation
            op = random.choice(self.operations)
            
            # Sample number of filters
            filters = random.randint(*self.num_filters_range)
            filters = (filters // 8) * 8  # Make divisible by 8
            
            # Sample activation
            activation = random.choice(self.activation_functions)
            
            architecture['layers'].append(op)
            architecture['filters'].append(filters)
            architecture['activations'].append(activation)
        
        return architecture
    
    def generate_neighbor_architectures(self, architecture: Dict) -> List[Dict]:
        """Generate neighbor architectures by mutating"""
        architecture = _snapshot_architecture(architecture, self)
        neighbors = []
        
        for i in range(len(architecture['layers'])):
            # Mutate operation
            new_arch = deepcopy(architecture)
            current_op = new_arch['layers'][i]
            available_ops = [op for op in self.operations if op != current_op]
            if available_ops:
                new_arch['layers'][i] = random.choice(available_ops)
                neighbors.append(new_arch)
            
            # Mutate filters
            new_arch = deepcopy(architecture)
            current_filters = new_arch['filters'][i]
            delta = random.choice([-8, 8, 16])
            new_filters = current_filters + delta
            if self.num_filters_range[0] <= new_filters <= self.num_filters_range[1]:
                new_filters = (new_filters // 8) * 8
                new_arch['filters'][i] = new_filters
                neighbors.append(new_arch)
            
            # Mutate activation
            new_arch = deepcopy(architecture)
            current_act = new_arch['activations'][i]
            available_acts = [act for act in self.activation_functions if act != current_act]
            if available_acts:
                new_arch['activations'][i] = random.choice(available_acts)
                neighbors.append(new_arch)
        
        return neighbors
    
    def encode_architecture(self, architecture: Dict) -> str:
        """Encode architecture as string"""
        encoding = []
        for i in range(len(architecture['layers'])):
            encoding.append(f"{architecture['layers'][i]}_{architecture['filters'][i]}_{architecture['activations'][i]}")
        return '|'.join(encoding)
    
    def decode_architecture(self, encoding: str) -> Dict:
        """Decode architecture from string"""
        parts = encoding.split('|')
        architecture = {
            'layers': [],
            'filters': [],
            'activations': []
        }
        for part in parts:
            op, filters, activation = part.split('_')
            architecture['layers'].append(op)
            architecture['filters'].append(int(filters))
            architecture['activations'].append(activation)
        return architecture

class NASModel(nn.Module):
    """Dynamic model based on architecture"""
    
    def __init__(self, architecture: Dict, input_shape: Tuple[int, ...] = (1, 28, 28)):
        super().__init__()
        self.architecture = _snapshot_architecture(architecture)
        self.input_shape = input_shape
        
        self.layers = nn.ModuleList()
        self.build_model()
        
        logger.info(f"✅ NAS Model built with {len(architecture['layers'])} layers")
    
    def build_model(self):
        """Build model from architecture"""
        in_channels = self.input_shape[0]
        current_size = self.input_shape[1]
        
        for i, (op, filters, activation) in enumerate(zip(
            self.architecture['layers'],
            self.architecture['filters'],
            self.architecture['activations']
        )):
            if op == 'conv3x3':
                layer = nn.Conv2d(in_channels, filters, kernel_size=3, padding=1)
                self.layers.append(layer)
                in_channels = filters
            elif op == 'conv5x5':
                layer = nn.Conv2d(in_channels, filters, kernel_size=5, padding=2)
                self.layers.append(layer)
                in_channels = filters
            elif op == 'conv7x7':
                layer = nn.Conv2d(in_channels, filters, kernel_size=7, padding=3)
                self.layers.append(layer)
                in_channels = filters
            elif op == 'maxpool3x3':
                layer = nn.MaxPool2d(3, stride=1, padding=1)
                self.layers.append(layer)
            elif op == 'avgpool3x3':
                layer = nn.AvgPool2d(3, stride=1, padding=1)
                self.layers.append(layer)
            elif op == 'identity':
                layer = nn.Identity()
                self.layers.append(layer)
            elif op == 'zero':
                layer = nn.ZeroPad2d(0)
                self.layers.append(layer)
            
            # Add activation
            if op not in ['maxpool3x3', 'avgpool3x3', 'zero']:
                if activation == 'relu':
                    self.layers.append(nn.ReLU())
                elif activation == 'tanh':
                    self.layers.append(nn.Tanh())
                elif activation == 'sigmoid':
                    self.layers.append(nn.Sigmoid())
                elif activation == 'swish':
                    self.layers.append(nn.SiLU())
        
        # Adaptive pooling and classifier
        self.layers.append(nn.AdaptiveAvgPool2d((1, 1)))
        self.layers.append(nn.Flatten())
        self.layers.append(nn.Linear(in_channels, 10))
    
    def forward(self, x: torch.Tensor) -> torch.Tensor:
        for layer in self.layers:
            x = layer(x)
        return x
    
    def get_flops(self) -> int:
        """Calculate FLOPs (simplified)"""
        total = 0
        for layer in self.layers:
            if isinstance(layer, nn.Conv2d):
                total += layer.weight.numel() * 2
            elif isinstance(layer, nn.Linear):
                total += layer.weight.numel() * 2
        return total
    
    def get_params(self) -> int:
        """Get number of parameters"""
        return sum(p.numel() for p in self.parameters())

class RLNASController:
    """Reinforcement Learning based NAS Controller"""
    
    def __init__(self, search_space: NASSearchSpace):
        self.search_space = search_space
        self.controller = self._build_controller()
        self.optimizer = torch.optim.Adam(self.controller.parameters(), lr=0.001)
        self.best_architecture = None
        self.best_accuracy = 0.0
        
        logger.info("✅ RL NAS Controller initialized")
    
    def _build_controller(self) -> nn.Module:
        """Build controller network"""
        class Controller(nn.Module):
            def __init__(self, output_size: int = 10):
                super().__init__()
                self.lstm = nn.LSTM(64, 128, num_layers=2, batch_first=True)
                self.fc = nn.Linear(128, output_size)
            
            def forward(self, x):
                lstm_out, _ = self.lstm(x)
                return self.fc(lstm_out)
        
        return Controller()
    
    def sample_architecture(self) -> Dict:
        """Sample architecture using controller"""
        # Simplified: use random for now
        return self.search_space.sample_random_architecture()
    
    def update_controller(self, architecture: Dict, reward: float):
        """Update controller based on reward"""
        # In production: use REINFORCE algorithm
        pass

class NASSearcher:
    """Main NAS search engine"""
    
    def __init__(self, search_space: NASSearchSpace):
        self.search_space = search_space
        self.search_history = []
        self.best_architecture = None
        self.best_performance = 0.0
        
        logger.info("✅ NAS Searcher initialized")
    
    def _publish(self, best_arch, best_score, history, method):
        # Publish only a completed run; every outward view has separate ownership.
        self.best_architecture = deepcopy(best_arch)
        self.best_performance = best_score
        self.search_history = deepcopy(history)
        return {
            'best_architecture': deepcopy(best_arch),
            'best_score': best_score,
            'history': deepcopy(history),
            'method': method,
        }

    def random_search(self, num_trials: int = 100, evaluator=None) -> Dict:
        """Evaluate independent candidates and publish exact score provenance."""
        num_trials = _positive_budget(num_trials, 'num_trials')
        history, best_arch, best_score = [], None, -float('inf')
        for trial in range(num_trials):
            arch = _snapshot_architecture(self.search_space.sample_random_architecture(), self.search_space)
            score = self._evaluate_architecture(arch, evaluator)
            history.append({'trial': trial, 'architecture': deepcopy(arch), 'score': score})
            if score > best_score:
                best_arch, best_score = deepcopy(arch), score
        return self._publish(best_arch, best_score, history, 'random')

    def evolutionary_search(self, population_size: int = 20, generations: int = 10, evaluator=None) -> Dict:
        """Select scored genotypes without aliasing parents, evaluators or winners."""
        population_size = _positive_budget(population_size, 'population_size')
        generations = _positive_budget(generations, 'generations')
        population = [_snapshot_architecture(self.search_space.sample_random_architecture(), self.search_space)
                      for _ in range(population_size)]
        history, best_arch, best_score = [], None, -float('inf')
        for generation in range(generations):
            scores = []
            for candidate, arch in enumerate(population):
                score = self._evaluate_architecture(arch, evaluator)
                scores.append(score)
                history.append({'trial': len(history), 'generation': generation,
                                'candidate': candidate, 'architecture': deepcopy(arch), 'score': score})
                if score > best_score:
                    best_arch, best_score = deepcopy(arch), score
            if generation + 1 == generations:
                break  # Do not generate an unevaluated final population.
            indices = sorted(range(population_size), key=lambda index: scores[index], reverse=True)
            elite_count = max(1, population_size // 2)
            elites = [deepcopy(population[index]) for index in indices[:elite_count]]
            next_population = deepcopy(elites)
            while len(next_population) < population_size:
                child = self._crossover(random.choice(elites), random.choice(elites))
                if random.random() < 0.3:
                    child = self._mutate(child)
                next_population.append(child)
            population = next_population
        return self._publish(best_arch, best_score, history, 'evolutionary')

    def _crossover(self, parent1: Dict, parent2: Dict) -> Dict:
        """Crossover two architectures"""
        parent1 = _snapshot_architecture(parent1, self.search_space)
        parent2 = _snapshot_architecture(parent2, self.search_space)
        child = {
            'layers': [],
            'filters': [],
            'activations': []
        }
        
        # Randomly choose from parents
        for i in range(min(len(parent1['layers']), len(parent2['layers']))):
            if random.random() < 0.5:
                child['layers'].append(parent1['layers'][i])
                child['filters'].append(parent1['filters'][i])
                child['activations'].append(parent1['activations'][i])
            else:
                child['layers'].append(parent2['layers'][i])
                child['filters'].append(parent2['filters'][i])
                child['activations'].append(parent2['activations'][i])
        
        return child
    
    def _mutate(self, architecture: Dict) -> Dict:
        """Mutate architecture"""
        architecture = _snapshot_architecture(architecture, self.search_space)
        choices = ['operation', 'filters', 'activation']
        if len(architecture['layers']) < self.search_space.num_layers_range[1]:
            choices.append('add_layer')
        if len(architecture['layers']) > self.search_space.num_layers_range[0]:
            choices.append('remove_layer')
        mutation_type = random.choice(choices)
        
        mutated = {
            'layers': architecture['layers'].copy(),
            'filters': architecture['filters'].copy(),
            'activations': architecture['activations'].copy()
        }
        
        if mutation_type == 'operation':
            idx = random.randint(0, len(mutated['layers']) - 1)
            current = mutated['layers'][idx]
            available = [op for op in self.search_space.operations if op != current]
            if available:
                mutated['layers'][idx] = random.choice(available)
        
        elif mutation_type == 'filters':
            idx = random.randint(0, len(mutated['filters']) - 1)
            current = mutated['filters'][idx]
            delta = random.choice([-8, 8, 16])
            new_val = current + delta
            if self.search_space.num_filters_range[0] <= new_val <= self.search_space.num_filters_range[1]:
                mutated['filters'][idx] = (new_val // 8) * 8
        
        elif mutation_type == 'activation':
            idx = random.randint(0, len(mutated['activations']) - 1)
            current = mutated['activations'][idx]
            available = [act for act in self.search_space.activation_functions if act != current]
            if available:
                mutated['activations'][idx] = random.choice(available)
        
        elif mutation_type == 'add_layer':
            # Add random layer
            new_op = random.choice(self.search_space.operations)
            new_filters = random.randint(*self.search_space.num_filters_range)
            new_filters = (new_filters // 8) * 8
            new_activation = random.choice(self.search_space.activation_functions)
            
            idx = random.randint(0, len(mutated['layers']))
            mutated['layers'].insert(idx, new_op)
            mutated['filters'].insert(idx, new_filters)
            mutated['activations'].insert(idx, new_activation)
        
        elif mutation_type == 'remove_layer':
            if len(mutated['layers']) > self.search_space.num_layers_range[0]:
                idx = random.randint(0, len(mutated['layers']) - 1)
                del mutated['layers'][idx]
                del mutated['filters'][idx]
                del mutated['activations'][idx]
        
        return mutated
    
    def _evaluate_architecture(self, architecture: Dict, evaluator=None) -> float:
        candidate = _snapshot_architecture(architecture, self.search_space)
        value = evaluator(candidate) if evaluator is not None else random.uniform(0, 1)
        if isinstance(value, bool):
            raise ValueError("evaluator score must be a finite number")
        try:
            score = float(value)
        except (TypeError, ValueError, OverflowError) as error:
            raise ValueError("evaluator score must be a finite number") from error
        if not math.isfinite(score):
            raise ValueError("evaluator score must be a finite number")
        return score
